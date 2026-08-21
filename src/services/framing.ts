/**
 * framing.ts
 *
 * ISOLATED ON PURPOSE. This is the one file you should expect to rewrite
 * once you've captured real bytes from the P50 Elite pushing files to this
 * app (see the big comment in TcpConnectionService.ts).
 *
 * Placeholder framing (best-effort guess, chosen only because it's a
 * reasonable superset of the QR TLV style and can actually carry binary
 * image data, which the QR-style 4-digit ASCII length prefix cannot):
 *
 *   [4 bytes ascii "type" tag, e.g. "IMG " or "CINE" or "RPT "]
 *   [8 bytes ascii decimal = name length N]
 *   [N bytes = file name, UTF-8]
 *   [12 bytes ascii decimal = payload length M]
 *   [M bytes = raw file payload]
 *
 * FileFrameReader buffers incoming TCP chunks (which may split a frame
 * across multiple `data` events, or bundle multiple frames into one) and
 * yields complete frames only.
 */
import { Buffer } from 'buffer';

export interface ReceivedFileFrame {
  kind: string; // 'IMG ' | 'CINE' | 'RPT ' | unknown
  name: string;
  bytes: Buffer;
}

const TYPE_TAG_LEN = 4;
const NAME_LEN_FIELD = 8;
const PAYLOAD_LEN_FIELD = 12;

export class FileFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): ReceivedFileFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ReceivedFileFrame[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerLen = TYPE_TAG_LEN + NAME_LEN_FIELD;
      if (this.buffer.length < headerLen) break;

      const kind = this.buffer.subarray(0, TYPE_TAG_LEN).toString('ascii');
      const nameLenStr = this.buffer.subarray(TYPE_TAG_LEN, headerLen).toString('ascii').trim();
      const nameLen = parseInt(nameLenStr, 10);
      if (Number.isNaN(nameLen) || nameLen < 0 || nameLen > 1024) {
        // Doesn't look like a valid frame start; drop one byte and resync.
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const nameEnd = headerLen + nameLen;
      const payloadLenEnd = nameEnd + PAYLOAD_LEN_FIELD;
      if (this.buffer.length < payloadLenEnd) break; // wait for more data

      const name = this.buffer.subarray(headerLen, nameEnd).toString('utf8');
      const payloadLenStr = this.buffer.subarray(nameEnd, payloadLenEnd).toString('ascii').trim();
      const payloadLen = parseInt(payloadLenStr, 10);
      if (Number.isNaN(payloadLen) || payloadLen < 0) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const frameEnd = payloadLenEnd + payloadLen;
      if (this.buffer.length < frameEnd) break; // wait for more data

      const bytes = this.buffer.subarray(payloadLenEnd, frameEnd);
      frames.push({ kind, name, bytes: Buffer.from(bytes) });
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Debug helper: call this from TcpConnectionService.handleIncomingBytes
 * temporarily (before frameReader.push) to dump raw bytes to a file for
 * later inspection when you do your first real-device test. Wire it up
 * via expo-file-system in a debug build; deliberately not auto-enabled here.
 */
export function describeRawChunkForDebugging(chunk: Buffer): string {
  const head = chunk.subarray(0, Math.min(64, chunk.length));
  return `len=${chunk.length} head_ascii=${JSON.stringify(head.toString('ascii'))} head_hex=${head.toString('hex')}`;
}
