// src/services/soundProtocol.ts
export const SOUND_MAGIC0 = 0xD1;
export const SOUND_MAGIC1 = 0xC3;
export const SOUND_VERSION = 1;

export interface SoundFrameHeader {
  magic0: number;
  magic1: number;
  version: number;
  frameType: number;
  sequence: number;
  totalFrames: number;
  payloadSize: number;
  checksum: number;
}

export interface SoundFrame {
  header: SoundFrameHeader;
  payload: Uint8Array;
}

export interface SoundTransferConfig {
  sampleRate?: number;
  baudRate?: number;
  freqMark?: number;
  freqSpace?: number;
}

export const DEFAULT_CONFIG: Required<SoundTransferConfig> = {
  sampleRate: 44100,
  baudRate: 16,
  freqMark: 1800,
  freqSpace: 1200,
};

export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function encodeSoundFrame(frame: SoundFrame): Uint8Array {
  const headerBytes = new Uint8Array(12);
  headerBytes[0] = frame.header.magic0;
  headerBytes[1] = frame.header.magic1;
  headerBytes[2] = frame.header.version;
  headerBytes[3] = frame.header.frameType;
  headerBytes[4] = (frame.header.sequence >> 24) & 0xFF;
  headerBytes[5] = (frame.header.sequence >> 16) & 0xFF;
  headerBytes[6] = (frame.header.sequence >> 8) & 0xFF;
  headerBytes[7] = frame.header.sequence & 0xFF;
  headerBytes[8] = (frame.header.totalFrames >> 24) & 0xFF;
  headerBytes[9] = (frame.header.totalFrames >> 16) & 0xFF;
  headerBytes[10] = (frame.header.totalFrames >> 8) & 0xFF;
  headerBytes[11] = frame.header.totalFrames & 0xFF;
  
  const payloadLen = frame.payload.length;
  const totalLen = 12 + 4 + payloadLen + 4;
  const result = new Uint8Array(totalLen);
  
  result.set(headerBytes, 0);
  result[12] = (payloadLen >> 24) & 0xFF;
  result[13] = (payloadLen >> 16) & 0xFF;
  result[14] = (payloadLen >> 8) & 0xFF;
  result[15] = payloadLen & 0xFF;
  result.set(frame.payload, 16);
  
  const checksum = fnv1a(frame.payload);
  result[16 + payloadLen] = (checksum >> 24) & 0xFF;
  result[17 + payloadLen] = (checksum >> 16) & 0xFF;
  result[18 + payloadLen] = (checksum >> 8) & 0xFF;
  result[19 + payloadLen] = checksum & 0xFF;
  
  return result;
}

export function decodeSoundFrame(bytes: Uint8Array): SoundFrame | null {
  if (bytes.length < 20) return null;
  if (bytes[0] !== SOUND_MAGIC0 || bytes[1] !== SOUND_MAGIC1) return null;
  
  const payloadSize = (bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15];
  if (bytes.length < 16 + payloadSize + 4) return null;
  
  const payload = bytes.slice(16, 16 + payloadSize);
  const expectedChecksum = (bytes[16 + payloadSize] << 24) | 
                          (bytes[17 + payloadSize] << 16) | 
                          (bytes[18 + payloadSize] << 8) | 
                          bytes[19 + payloadSize];
  const actualChecksum = fnv1a(payload);
  
  if (expectedChecksum !== actualChecksum) return null;
  
  return {
    header: {
      magic0: bytes[0],
      magic1: bytes[1],
      version: bytes[2],
      frameType: bytes[3],
      sequence: (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7],
      totalFrames: (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11],
      payloadSize,
      checksum: expectedChecksum,
    },
    payload,
  };
}
