// src/services/SoundTransferService.ts
import { encodeSoundFrame, decodeSoundFrame, fnv1a, DEFAULT_CONFIG, type SoundFrame, type SoundTransferConfig } from './soundProtocol';

export interface SoundTransferProgress {
  phase: 'encoding' | 'transmitting' | 'receiving' | 'assembling';
  progress: number;
  total: number;
  framesSent: number;
  framesReceived: number;
  elapsed: number;
}

export interface SoundTransferResult {
  success: boolean;
  fileSize: number;
  duration: number;
  framesCount: number;
  checksum: string;
  fileName?: string;
  fileType?: string;
  error?: string;
}

export interface SoundSenderOptions {
  fileData: Uint8Array;
  fileName: string;
  fileType: string;
  onProgress?: (progress: SoundTransferProgress) => void;
  onError?: (error: string) => void;
  onComplete?: () => void;
}

export class SoundSender {
  private audioContext: AudioContext | null = null;
  private isSending = false;
  private config: typeof DEFAULT_CONFIG;
  private onProgress?: (progress: SoundTransferProgress) => void;
  private onError?: (error: string) => void;
  private onComplete?: () => void;
  
  constructor(
    private fileData: Uint8Array,
    private fileName: string,
    private fileType: string,
    config: typeof DEFAULT_CONFIG = DEFAULT_CONFIG,
    onProgress?: (progress: SoundTransferProgress) => void,
    onError?: (error: string) => void,
    onComplete?: () => void
  ) {
    this.config = config;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onComplete = onComplete;
  }
  
  async start(): Promise<void> {
    try {
      this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate });
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 0.8;
      gainNode.connect(this.audioContext.destination);
      
      this.isSending = true;
      await this.transmitFile(gainNode);
      this.onComplete?.();
    } catch (error) {
      this.onError?.(String(error));
    } finally {
      if (this.audioContext) {
        await this.audioContext.close();
        this.audioContext = null;
      }
      this.isSending = false;
    }
  }
  
  private async transmitFile(gainNode: GainNode): Promise<void> {
    const totalFrames = Math.ceil(this.fileData.length / 256);
    this.onProgress?.({
      phase: 'encoding',
      progress: 0,
      total: totalFrames,
      framesSent: 0,
      framesReceived: 0,
      elapsed: 0,
    });
    
    const headerFrame = this.createHeaderFrame();
    await this.playFrame(headerFrame, gainNode);
    
    for (let i = 0; i < totalFrames; i++) {
      if (!this.isSending) break;
      
      const start = i * 256;
      const end = Math.min(start + 256, this.fileData.length);
      const chunk = this.fileData.slice(start, end);
      const checksum = fnv1a(chunk);
      
      const frame: SoundFrame = {
        header: {
          magic0: 0xD1, magic1: 0xC3, version: 1, frameType: 1,
          sequence: i, totalFrames, payloadSize: chunk.length, checksum,
        },
        payload: chunk,
      };
      
      await this.playFrame(frame, gainNode);
      this.onProgress?.({
        phase: 'transmitting',
        progress: i + 1,
        total: totalFrames,
        framesSent: i + 1,
        framesReceived: 0,
        elapsed: Date.now() - this.startTime,
      });
      await this.sleep(30);
    }
    
    const endFrame = this.createEndFrame(totalFrames);
    await this.playFrame(endFrame, gainNode);
  }
  
  private createHeaderFrame(): SoundFrame {
    const fnBytes = new TextEncoder().encode(this.fileName);
    const ftBytes = new TextEncoder().encode(this.fileType);
    const sizeBytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) sizeBytes[i] = (this.fileData.length >> (56 - i * 8)) & 0xFF;
    const payload = new Uint8Array(64 + 16 + 8);
    payload.set(fnBytes.padEnd(64, 0), 0);
    payload.set(ftBytes.padEnd(16, 0), 64);
    payload.set(sizeBytes, 80);
    return {
      header: {
        magic0: 0xD1, magic1: 0xC3, version: 1, frameType: 0,
        sequence: 0, totalFrames: 0, payloadSize: payload.length,
        checksum: fnv1a(payload),
      },
      payload,
    };
  }
  
  private createEndFrame(totalFrames: number): SoundFrame {
    return {
      header: {
        magic0: 0xD1, magic1: 0xC3, version: 1, frameType: 3,
        sequence: totalFrames, totalFrames, payloadSize: 0, checksum: 0,
      },
      payload: new Uint8Array(0),
    };
  }
  
  private async playFrame(frame: SoundFrame, gainNode: GainNode): Promise<void> {
    const frameBytes = encodeSoundFrame(frame);
    const audioBuffer = this.frameToAudio(frameBytes);
    return new Promise((resolve) => {
      if (!this.audioContext) { resolve(); return; }
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      source.onended = resolve;
      source.start();
    });
  }
  
  private frameToAudio(frameBytes: Uint8Array): AudioBuffer {
    const { sampleRate, baudRate, freqMark, freqSpace } = this.config;
    const spb = Math.floor(sampleRate / baudRate);
    const preambleBits = 32;
    const totalBits = preambleBits + (frameBytes.length * 8);
    const totalSamples = totalBits * spb;
    const audioData = new Float32Array(totalSamples);
    let offset = 0;
    
    for (let bitIndex = 0; bitIndex < totalBits; bitIndex++) {
      let bit: number;
      if (bitIndex < preambleBits) bit = bitIndex % 2;
      else {
        const byteIndex = Math.floor((bitIndex - preambleBits) / 8);
        const bitInByte = 7 - ((bitIndex - preambleBits) % 8);
        bit = (frameBytes[byteIndex] >> bitInByte) & 1;
      }
      const freq = bit ? freqMark : freqSpace;
      for (let j = 0; j < spb; j++) {
        const t = (offset + j) / sampleRate;
        audioData[offset + j] = Math.sin(2 * Math.PI * freq * t);
      }
      offset += spb;
    }
    
    const audioBuffer = this.audioContext!.createBuffer(1, totalSamples, sampleRate);
    audioBuffer.getChannelData(0).set(audioData);
    return audioBuffer;
  }
  
  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
  
  stop(): void {
    this.isSending = false;
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }
}
