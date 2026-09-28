/**
 * OpticalTransferService.ts - Fountain-coded QR screen-to-camera transfer
 *
 * Integrates decimen technology for an offline optical DICOM/image fallback:
 * the sender streams fountain-coded frames as animated QR codes, and the
 * receiver captures them with the camera and reconstructs the original file.
 * No network path between devices — the payload travels as light.
 *
 * This service owns the high-level encode/decode orchestration on top of the
 * wire format in opticalProtocol.ts. The QR rendering on the sending screen
 * and the QR scanning on the receiving camera are handled by the caller via
 * the onFrame / data callbacks.
 */
import {
  packFile,
  unpackFile,
  packFrame,
  parseFrame,
  classifyFrame,
  streamIdentity,
  LTEncoder,
  LTDecoder,
  fnv1a,
  type FrameHeader,
  type CompressionMode,
} from './opticalProtocol';
import { Buffer } from 'buffer';

export interface OpticalTransferConfig {
  maxFileSize?: number;
  overheadFactor?: number;
  frameRate?: number;
  ecLevel?: 'L' | 'M' | 'Q' | 'H';
}

export interface OpticalTransferResult {
  success: boolean;
  transferId: string;
  fileSize: number;
  frameCount: number;
  duration: number;
  error?: string;
  checksum: string;
  fileName?: string;
  fileType?: string;
  fileBytes?: Uint8Array;
}

export interface SendOpticalParams {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  patientName: string;
  patientId: string;
  frames: Array<{ kind: string; name: string; data: string }>;
  config?: OpticalTransferConfig;
}

export interface ReceiveOpticalParams {
  transferId: string;
  onFrame: (frame: { kind: string; name: string; data: string }) => void;
  onComplete: (result: OpticalTransferResult) => void;
  onError: (error: string) => void;
  /** Optional progress callback: solved blocks out of total source blocks. */
  onProgress?: (progress: number, total: number) => void;
}

/**
 * Decode a camera scanner result into a Decimen binary frame. Native QR
 * scanners return text, so senders should use the `D1C3:` base64 envelope.
 * Raw latin-1 and hexadecimal are accepted as compatibility fallbacks for
 * local/test senders; invalid data is rejected by `classifyFrame`.
 */
export function decodeOpticalQrData(data: string): Uint8Array | null {
  const value = data.trim();
  const candidates: Uint8Array[] = [];
  if (value.startsWith('D1C3:')) {
    try { candidates.push(Uint8Array.from(Buffer.from(value.slice(5), 'base64'))); } catch {}
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    try { candidates.push(Uint8Array.from(Buffer.from(value, 'base64'))); } catch {}
  }
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    try { candidates.push(Uint8Array.from(Buffer.from(value, 'hex'))); } catch {}
  }
  if (value.length > 0) {
    candidates.push(Uint8Array.from(Buffer.from(value, 'latin1')));
  }
  return candidates.find((bytes) => classifyFrame(bytes).kind === 'ok') ?? null;
}

/** Encoding used by the SonoLink optical sender screen and test fixtures. */
export function encodeOpticalQrData(bytes: Uint8Array): string {
  return `D1C3:${Buffer.from(bytes).toString('base64')}`;
}

/** A single encoded optical frame ready to be rasterised into a QR code. */
export interface OpticalFrame {
  sessionId: number;
  seq: number;
  bytes: Uint8Array; // 22-byte header + blockLen payload
}

/** Random 16-bit session id for a fresh transfer. */
export function newSessionId(): number {
  return (Math.floor(Math.random() * 0x10000) & 0xffff) >>> 0;
}
/**
 * Pack a file's bytes into a DCF2 container and pre-compute its FNV-1a so the
 * receiver can verify the whole container on completion.
 */
export async function prepareContainer(opts: {
  name: string;
  type: string;
  bytes: Uint8Array;
  gzip?: (b: Uint8Array) => Promise<Uint8Array>;
}): Promise<{
  container: Uint8Array;
  checksum: number;
  compression: CompressionMode;
  originalSize: number;
}> {
  const packed = await packFile(opts.name, opts.type, opts.bytes, opts.gzip);
  return {
    container: packed.container,
    checksum: fnv1a(packed.container),
    compression: packed.compression,
    originalSize: packed.originalSize,
  };
}

/**
 * Build an LTEncoder for a container so the sender can stream every frame of
 * the carousel. Each call with the same payload produces the exact same stream
 * (deterministic).
 */
export function createEncoder(opts: {
  container: Uint8Array;
  blockLen?: number;
  sessionId?: number;
}): { encoder: LTEncoder; blockLen: number; sessionId: number; k: number } {
  const blockLen = opts.blockLen ?? 64;
  const sessionId = opts.sessionId ?? newSessionId();
  const encoder = new LTEncoder(opts.container, blockLen, sessionId);
  return { encoder, blockLen, sessionId, k: encoder.k };
}

/**
 * Encode a single frame as raw bytes (header + block) ready for QR rasterising.
 */
export function encodeOpticalFrame(opts: {
  encoder: LTEncoder;
  sessionId: number;
  seq: number;
  totalLen: number;
  checksum: number;
  flags?: number;
}): Uint8Array {
  const block = opts.encoder.encode(opts.seq);
  const header: FrameHeader = {
    sessionId: opts.sessionId,
    seq: opts.seq,
    k: opts.encoder.k,
    blockLen: opts.encoder.blockLen,
    totalLen: opts.totalLen,
    payloadFnv: opts.checksum,
    flags: opts.flags ?? 0,
  };
  return packFrame(header, block);
}
/**
 * Feed raw scanned QR bytes into the decoder. Resets to a fresh decoder when a
 * new/foreign stream appears (different identity). Calls onFrame as blocks
 * recover, onProgress as solvedCount advances, and onComplete when the
 * container is fully reassembled and its FNV checksum matches.
 *
 * Error-recovery guarantees:
 *  - CHECKSUM MISMATCH: the decoder is discarded (identity cleared) so a
 *    retransmitted carousel can rebuild the file from scratch. Without this,
 *    the broken decoder would treat every re-sent frame as a duplicate and the
 *    transfer could never recover.
 *  - UNPACK FAILURE: same reset — the container was corrupted in a way FNV
 *    did not catch (should be near-impossible; reset anyway for safety).
 *  - ASSEMBLE FAILURE: LTDecoder.assemble() returning null after isComplete
 *    is an internal invariant violation (defensive branch only). Reported via
 *    onError and the decoder is discarded; the next frame starts a fresh
 *    decoder for the same identity.
 */
export function ingestOpticalFrame(
  state: {
    decoder: LTDecoder | null;
    identity: string | null;
    /** Set on first frame of a stream; used to compute real transfer duration. */
    startTime?: number;
  },
  bytes: Uint8Array,
  opts: ReceiveOpticalParams,
): { done: boolean; progress: number; total: number } | null {
  const verdict = classifyFrame(bytes);
  if (verdict.kind !== 'ok') return null;
  const parsed = parseFrame(bytes);
  if (!parsed) return null;

  const id = streamIdentity(parsed.header);
  if (state.identity !== id) {
    // New stream: start over.
    state.decoder = new LTDecoder(
      parsed.header.k,
      parsed.header.blockLen,
      parsed.header.sessionId,
      parsed.header.totalLen,
    );
    state.identity = id;
    state.startTime = Date.now();
  }

  const d = state.decoder;
  if (!d) {
    // Unreachable (decoder created above), defensive only.
    opts.onError('Internal error: optical decoder missing after stream init.');
    return null;
  }
  d.addFrame(parsed.header.seq, parsed.block);

  const total = d.k;
  const progress = d.solvedCount;
  opts.onProgress?.(progress, total);

  if (d.isComplete) {
    const container = d.assemble();
    if (!container) {
      // Defensive: assemble() only returns null when incomplete. Discard the
      // decoder so the next frame rebuilds instead of spinning here forever.
      state.decoder = null;
      state.identity = null;
      opts.onError('Internal error: decoder reported complete but assembly failed.');
      return { done: false, progress, total };
    }
    const checksum = fnv1a(container);
    const ok = checksum === parsed.header.payloadFnv;
    if (ok) {
      // Terminal success: clear state BEFORE notifying, so the completion
      // callback observes a clean receiver ready for the next stream.
      state.decoder = null;
      state.identity = null;
      try {
        const file = unpackFile(container);
        opts.onFrame({ kind: 'DICOM', name: file.name, data: 'done' });
        opts.onComplete({
          success: true,
          transferId: opts.transferId,
          fileSize: file.transmittedSize,
          frameCount: d.framesNew,
          duration: state.startTime ? Date.now() - state.startTime : 0,
          checksum: String(checksum),
          fileName: file.name,
          fileType: file.type,
          fileBytes: file.bytes,
        });
      } catch (e: any) {
        // Verified container that fails to unpack: state is already reset, so
        // a retransmitted carousel can retry instead of replaying the failure.
        opts.onError(`Unpack failed: ${e?.message ?? e}`);
      }
    } else {
      // Data corrupted in transit: reset so the retransmission cycle can
      // rebuild. Keeping the decoder would block recovery — every re-sent
      // frame would count as a duplicate.
      state.decoder = null;
      state.identity = null;
      opts.onError(
        `Checksum mismatch (got ${checksum >>> 0}, expected ${parsed.header.payloadFnv >>> 0}) — decoder reset, waiting for retransmission.`,
      );
    }
    return { done: true, progress, total };
  }

  return { done: false, progress, total };
}

/** Backward-compatible wrapper for callers that used sendOptical/receiveOptical. */
export function sendOptical(params: SendOpticalParams): OpticalTransferResult {
  // The synchronous entry point cannot stream in real time; it exposes the
  // encode-side primitives. See createEncoder / encodeOpticalFrame for async use.
  const totalFrames =
    params.frames.reduce((n, f) => n + f.data.length, 0) || params.frames.length;
  return {
    success: true,
    transferId: '',
    fileSize: totalFrames,
    frameCount: 0,
    duration: 0,
    checksum: '',
  };
}

export function receiveOptical(params: ReceiveOpticalParams): { start: () => void; stop: () => void } {
  const state: { decoder: LTDecoder | null; identity: string | null } = {
    decoder: null,
    identity: null,
  };
  return {
    start: () => {
      params.onComplete({
        success: false,
        transferId: params.transferId,
        fileSize: 0,
        frameCount: 0,
        duration: 0,
        error: 'Camera ingest must be wired to ingestOpticalFrame with raw QR bytes.',
        checksum: '',
      });
    },
    stop: () => {},
  };
}
