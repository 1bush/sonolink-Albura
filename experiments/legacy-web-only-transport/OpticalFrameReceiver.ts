/**
 * OpticalFrameReceiver.ts
 *
 * Hybrid controller: Decimen QR framing + frame-to-frame transfer + quick validation.
 * Empty/corrupt frames are logged and REJECTED — never saved to disk.
 */

import { Buffer } from 'buffer';
import {
  classifyFrame,
  parseFrame,
  streamIdentity,
  LTDecoder,
  fnv1a,
  unpackFile,
} from './opticalProtocol';
import { decodeOpticalQrData } from './OpticalTransferService';

export interface OpticalFrame {
  seq: number;
  bytes: Uint8Array;
}

export interface FrameValidation {
  valid: boolean;
  reason: string;
  stats: FrameStats;
}

/** Per-frame quality metrics — used for the quality indicator UI. */
export interface FrameStats {
  size: number;
  entropy: number;
  ffPercent: number;
  zeroPercent: number;
  hasSoi: boolean;
  hasEoi: boolean;
  isValidJpeg: boolean;
}

export interface TransferProgress {
  progress: number;
  total: number;
  valid: boolean;
  receiverState: ReceiverState;
}

export interface ReceiverState {
  transferId: string;
  sessionId: number;
  received: number;
  total: number;
  identity: string | null;
  startTime: number;
}

export interface CompletedFile {
  name: string;
  bytes: Uint8Array;
  checksum: string;
  frameCount: number;
}

export type FrameCallback = (frame: OpticalFrame, index: number, stats: FrameStats) => void;
export type InvalidCallback = (reason: string, stats: FrameStats) => void;
export type CompleteCallback = (file: CompletedFile) => void;
export type ErrorCallback = (error: string) => void;
export type LogCallback = (entry: DebugLogEntry) => void;

export interface DebugLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  details?: any;
}

// ── Helpers ──────────────────────────────────────────────────────

function bytesMatch(buf: Uint8Array, pattern: number[]): boolean {
  if (buf.length < pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (buf[i] !== pattern[i]) return false;
  }
  return true;
}

function findBytes(buf: Uint8Array, pattern: number[]): number {
  for (let i = 0; i <= buf.length - pattern.length; i++) {
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function calculateEntropy(buf: Uint8Array, sampleLen?: number): number {
  if (buf.length === 0) return 0;
  const n = sampleLen ?? Math.min(buf.length, 256);
  const freq = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) freq[buf[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / n;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

function computeFrameStats(bytes: Uint8Array): FrameStats {
  const size = bytes.length;
  const sampleLen = Math.min(size, 1024);
  let ffCount = 0;
  let zeroCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0xFF) ffCount++;
    if (bytes[i] === 0x00) zeroCount++;
  }
  const entropy = size > 64 ? calculateEntropy(bytes) : 0;
  const hasSoi = size >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8;
  const hasEoi = findBytes(bytes, [0xFF, 0xD9]) >= 0;
  return {
    size,
    entropy,
    ffPercent: Math.round((ffCount / sampleLen) * 100),
    zeroPercent: Math.round((zeroCount / sampleLen) * 100),
    hasSoi,
    hasEoi,
    isValidJpeg: hasSoi && hasEoi,
  };
}

// ── Constants ───────────────────────────────────────────────────

const MIN_FRAME_BYTES = 64;
const FRAME_LOG_KEY = 'sonolink_optical_receiver_state';
const DEBUG_LOG_KEY = 'sonolink_optical_debug_log';
const MAX_DEBUG_LOGS = 500;
const MAX_PENDING_FRAMES = 100;

// ── Class ───────────────────────────────────────────────────────

export class OpticalFrameReceiver {
  private decoder: LTDecoder | null = null;
  private identity: string | null = null;
  private totalFrames: number = 0;
  private receivedCount: number = 0;
  private transferId: string = '';
  private startTime: number = 0;

  private onFrameValid?: FrameCallback;
  private onFrameInvalid?: InvalidCallback;
  private onComplete?: CompleteCallback;
  private onError?: ErrorCallback;
  private onLog?: LogCallback;

  /** Resumable state — stores frames that arrived before decoder was ready. */
  private pendingFrames: Map<number, Uint8Array> = new Map();

  constructor() {}

  setCallbacks(
    onFrameValid?: FrameCallback,
    onFrameInvalid?: InvalidCallback,
    onComplete?: CompleteCallback,
    onError?: ErrorCallback,
    onLog?: LogCallback,
  ): void {
    this.onFrameValid = onFrameValid;
    this.onFrameInvalid = onFrameInvalid;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onLog = onLog;
  }

  log(level: 'info' | 'warn' | 'error' | 'success', message: string, details?: any): void {
    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      details,
    };
    this.onLog?.(entry);
    if (level === 'error' || (typeof __DEV__ !== 'undefined' && __DEV__)) {
      const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
      console.log(`[OpticalFrameReceiver ${level}]`, message, details ?? '');
    }
  }

  ingestQrFrame(qrData: string): TransferProgress | null {
    this.log('info', `QR scanned: ${qrData.length} chars`);

    // 1. Decode QR to raw bytes
    const bytes = decodeOpticalQrData(qrData);
    if (!bytes) {
      this.log('warn', 'Invalid QR data — cannot decode');
      this.onFrameInvalid?.('Invalid QR data — cannot decode', computeFrameStats(new Uint8Array(0)));
      return null;
    }

    this.log('info', `Decoded ${bytes.length} bytes from QR`);

    // 2. Quick validation (Idea 1: reject empty/corrupt frames)
    const validation = this.quickValidate(bytes);
    if (!validation.valid) {
      this.log('warn', `Frame rejected: ${validation.reason}`, validation.stats);
      this.onFrameInvalid?.(validation.reason, validation.stats);
      return null;
    }

    this.log('info', `Frame validated: ${bytes.length} bytes, entropy=${validation.stats.entropy.toFixed(2)}`);

    // 3. Classify frame
    const verdict = classifyFrame(bytes);
    if (verdict.kind !== 'ok') {
      this.log('warn', `Frame classification failed: ${verdict.kind}`);
      this.onFrameInvalid?.(`Classification failed: ${verdict.kind}`, computeFrameStats(bytes));
      return null;
    }

    // 4. Parse frame
    const parsed = parseFrame(bytes);
    if (!parsed) {
      this.log('error', 'Frame parsing failed');
      this.onFrameInvalid?.(`Parse failed`, computeFrameStats(bytes));
      return null;
    }

    const id = streamIdentity(parsed.header);
    this.log('info', `Frame seq=${parsed.header.seq}/${parsed.header.k} session=${parsed.header.sessionId}`);

    // 5. Detect new stream (resumable: new session = new transfer)
    if (this.identity !== id) {
      this.log('info', 'New stream detected — resetting receiver');
      this.reset();
      this.decoder = new LTDecoder(
        parsed.header.k,
        parsed.header.blockLen,
        parsed.header.sessionId,
        parsed.header.totalLen,
      );
      this.identity = id;
      this.transferId = `optical_${id}_${Date.now()}`;
      this.totalFrames = parsed.header.k;
      this.receivedCount = 0;
      this.startTime = Date.now();
      this.pendingFrames.clear();
      this.log('success', `Transfer started: ${this.transferId}, ${this.totalFrames} frames needed`);
    }

    // Guard: decoder must exist by now (created above on new stream).
    if (!this.decoder) {
      this.log('error', 'Decoder missing after stream init — aborting frame');
      this.onError?.('Internal error: optical decoder not initialised');
      return null;
    }

    // Store frame in pending buffer (for resumable transfers)
    if (this.pendingFrames.size < MAX_PENDING_FRAMES) {
      this.pendingFrames.set(parsed.header.seq, new Uint8Array(parsed.block));
    }

    // 6. Add frame to decoder (Decimen core logic)
    this.decoder.addFrame(parsed.header.seq, parsed.block);
    this.receivedCount++;

    // Notify valid frame with quality stats (Idea 5: frame quality indicator)
    this.onFrameValid?.(
      { seq: parsed.header.seq, bytes: parsed.block },
      this.receivedCount,
      computeFrameStats(bytes),
    );

    // 7. Check if transfer is complete
    if (this.decoder.isComplete) {
      this.log('info', 'Decoder complete — assembling file');
      const container = this.decoder.assemble();
      if (!container) {
        this.log('error', 'Failed to assemble file from blocks');
        this.onError?.('Failed to assemble file from blocks');
        return { progress: this.receivedCount, total: this.totalFrames, valid: true, receiverState: this.getState() };
      }

      const checksum = fnv1a(container);
      if (checksum !== parsed.header.payloadFnv) {
        this.log('error', `Checksum mismatch: computed=${checksum}, expected=${parsed.header.payloadFnv}`);
        this.onError?.('Checksum mismatch — data corrupted in transit');
        return { progress: this.receivedCount, total: this.totalFrames, valid: true, receiverState: this.getState() };
      }

      this.log('success', `Checksum verified: ${checksum}`);

      // 8. Unpack file (Idea 1: progressive save — only save after full assembly)
      const file = unpackFile(container);
      this.log('success', `File unpacked: ${file.name}, ${file.transmittedSize} bytes`);

      this.onComplete?.({
        name: file.name,
        bytes: file.bytes,
        checksum: String(checksum),
        frameCount: this.receivedCount,
      });

      // Persist debug log (Idea 4: debug log export)
      this.persistDebugLog();

      return {
        progress: this.totalFrames,
        total: this.totalFrames,
        valid: true,
        receiverState: this.getState(),
      };
    }

    return {
      progress: this.receivedCount,
      total: this.totalFrames,
      valid: true,
      receiverState: this.getState(),
    };
  }

  quickValidate(bytes: Uint8Array): { valid: boolean; reason: string; stats: FrameStats } {
    const stats = computeFrameStats(bytes);

    if (bytes.length === 0) {
      return { valid: false, reason: 'Empty frame — zero bytes received', stats };
    }

    if (bytes.length < MIN_FRAME_BYTES) {
      return { valid: false, reason: `Frame too small: ${bytes.length} bytes (min ${MIN_FRAME_BYTES})`, stats };
    }

    // >80% 0xFF = padding or failed QR capture
    if (stats.ffPercent > 80) {
      return { valid: false, reason: `Frame ${stats.ffPercent}% 0xFF — likely padding or bad capture`, stats };
    }

    // >80% zeros = empty payload
    if (stats.zeroPercent > 80) {
      return { valid: false, reason: `Frame ${stats.zeroPercent}% zeros — likely empty data`, stats };
    }

    // Low entropy = repetitive/empty data
    if (bytes.length > 128 && stats.entropy < 1.0) {
      return { valid: false, reason: `Low entropy: ${stats.entropy.toFixed(2)} bits — empty or repetitive data`, stats };
    }

    return { valid: true, reason: '', stats };
  }

  /**
   * Reset receiver state for a new transfer.
   */
  reset(): void {
    this.decoder = null;
    this.identity = null;
    this.totalFrames = 0;
    this.receivedCount = 0;
    this.transferId = '';
    this.startTime = 0;
    this.pendingFrames.clear();
  }

  /**
   * Clear pending frames buffer (used for resumable transfers).
   */
  clearPendingFrames(): void {
    this.pendingFrames.clear();
    this.log('info', 'Pending frames cleared');
  }

  // ── Resumable Transfers ────────────────────────────────────────

  getState(): ReceiverState {
    return {
      transferId: this.transferId,
      sessionId: this.decoder?.sessionId ?? 0,
      received: this.receivedCount,
      total: this.totalFrames,
      identity: this.identity,
      startTime: this.startTime,
    };
  }

  persistState(): void {
    try {
      const state = this.getState();
      state.startTime = Date.now();
      const pendingSeqs = Array.from(this.pendingFrames.keys());
      const data = {
        state,
        pendingFrameCount: pendingSeqs.length,
        savedAt: Date.now(),
      };
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(FRAME_LOG_KEY, JSON.stringify(data));
      }
      this.log('info', `State persisted: ${pendingSeqs.length} pending frames`);
    } catch (e) {
      this.log('warn', 'Failed to persist state', e);
    }
  }

  loadState(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem(FRAME_LOG_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data?.state) return false;
      if (data.state.identity) {
        this.identity = data.state.identity;
        this.transferId = data.state.transferId;
        this.totalFrames = data.state.total;
        this.receivedCount = data.state.received;
        this.startTime = data.state.startTime;
        this.log('info', `State loaded: ${this.receivedCount}/${this.totalFrames} frames`);
        return true;
      }
    } catch (e) {
      this.log('warn', 'Failed to load state', e);
    }
    return false;
  }

  clearPersistedState(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(FRAME_LOG_KEY);
      }
      this.log('info', 'Persisted state cleared');
    } catch {}
  }

  // ── Debug Log Export ───────────────────────────────────────────

  addDebugLog(level: 'info' | 'warn' | 'error' | 'success', message: string, details?: any): void {
    const entry: DebugLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      details,
    };
    this.onLog?.(entry);
    try {
      const logs = this.getDebugLogs();
      logs.push(entry);
      if (logs.length > MAX_DEBUG_LOGS) {
        logs.splice(0, logs.length - MAX_DEBUG_LOGS);
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(logs));
      }
    } catch {}
  }

  getDebugLogs(): DebugLogEntry[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(DEBUG_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  exportDebugLogs(): string {
    const logs = this.getDebugLogs();
    const lines: string[] = [
      '=== SonoLink Optical Transfer Debug Log ===',
      `Export time: ${new Date().toISOString()}`,
      `Total entries: ${logs.length}`,
      '',
    ];
    for (const e of logs) {
      const time = new Date(e.timestamp).toLocaleTimeString('sq-AL');
      const prefix = e.level === 'error' ? '❌' : e.level === 'warn' ? '⚠️' : e.level === 'success' ? '✅' : 'ℹ️';
      lines.push(`[${time}] ${prefix} ${e.message}`);
      if (e.details != null) {
        lines.push(`       ${JSON.stringify(e.details)}`);
      }
    }
    lines.push('');
    lines.push('=== End of log ===');
    return lines.join('\n');
  }

  /** Exports debug logs to a downloadable text file (WebView/HTML context). */
  saveDebugLogsToFile(): void {
    try {
      const content = this.exportDebugLogs();
      if (typeof Blob === 'undefined' || typeof URL === 'undefined') {
        this.log('warn', 'Blob/URL not available — cannot export file');
        return;
      }
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sonolink-optical-debug-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.log('success', 'Debug log exported to file');
    } catch (e) {
      this.log('error', 'Failed to export debug log', e);
    }
  }

  /** Persists a summary entry when transfer completes. */
  persistDebugLog(): void {
    this.addDebugLog('success', `Transfer COMPLETE: ${this.transferId}`, {
      framesReceived: this.receivedCount,
      totalFrames: this.totalFrames,
      elapsed: this.startTime ? Date.now() - this.startTime : 0,
      pendingFrames: this.pendingFrames.size,
    });
  }
}
