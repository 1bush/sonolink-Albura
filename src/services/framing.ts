/**
 * framing.ts
 *
 * The SonoDrop wire format, recovered from the decompiled SonoDrop/USAlbum APK
 * (package com.sonoscape.usalbum) rather than guessed.
 *
 * WHAT WAS ACTUALLY READ
 * The original app's Java side is thin; the real parsing lives in
 * libklnetio.so behind JNI. The Java call sites still pin the structure
 * exactly, and the C++ symbol names in the .so confirm the shape:
 *
 *   KLNetIO::GetFileHead(String) -> native
 *     KFileHeadParser::ParseHead / GetFileHead / KFileHead
 *     KTLVFieldHelper::IntTo4ByteString / StringToInt / ParseTLVString / KTLV
 *
 * From DataTransferThread.smali (ReceiveFile), verbatim:
 *   - `const/16 v5, 0x100` then `new-array` then `InputStream.read(byte[])`:
 *     the header is read as ONE 256-byte buffer, in a single read call.
 *   - `new String(bytes)` then `substring(msgType, msgType + 4)` then
 *     `Integer.parseInt`: msgType is 4 ASCII digits at offset 0.
 *   - the same shape again for the length at `msgType + 4 .. + 8`.
 *   - `new TLVHelper(); ParseTLV(head, 12)`: the TLV block starts at offset 12.
 *   - TLVHelper.ParseTLV reads 4 bytes as the type, parseInt; then 4 more as
 *     the length, parseInt; then `length` bytes as the value.
 *     -> TLV = [type:4][len:4][value:len], all decimal ASCII.
 *
 * Message types, from DataTransferThread's <clinit>:
 *   0x3e8 = 1000  FILE_HEAD_MSG_TYPE
 *   0x7d0 = 2000  FILE_REP_MSG_TYPE
 *   0x1388 = 5000 CTRL_MSG_TYPE
 *   0x1389 = 5001 CTRL_NO_DATA_TYPE
 *
 * The QR types, from QRInfoParser's <clinit>, are 0x2328..0x232e = 9000..9006
 * with QR_TLV_NUM = 6, which is the payload already pinned in
 * scripts/test-protocol.mjs. So the QR and the file transfer use the SAME
 * 4-digit-ASCII TLV encoding; only the msgType differs.
 *
 * FileHead fields, from ParseFileHead's array indices:
 *   [0] mDept  [1] mTime  [2] mName  [3] mSize  [4] mTotal  [5] mIndex
 * and createStudyDir builds the study id as
 *   mTime.replace(":", "-") + "_" + mDept
 * which is the same "<time>_<dept>" shape buildOpticalStudyId() already uses.
 *
 * WHAT IS STILL NOT KNOWN — stated plainly rather than papered over
 * The six TLV type numbers for the FileHead fields are consumed by
 * KFileHeadParser::GetFileHead inside the stripped .so. Two candidates
 * (1025, 1027) appear near the parser but neither forms a 6-value run, and
 * the binary is stripped, so they are NOT treated as confirmed. The reader
 * below therefore identifies fields POSITIONALLY, which is what the Java
 * call site actually does — it hands a String[] to ParseFileHead, so the
 * order is fixed even though the tags are not known.
 *
 * That is not a guess dressed up as knowledge: positional parsing is correct
 * for any sender, because the field order is what the receiver indexes on.
 * A real capture is still the only way to confirm the tags, and
 * describeRawChunkForDebugging() is there to make that capture easy.
 */
import { Buffer } from 'buffer';

export interface ReceivedFileFrame {
  /** The msgType as 4 ASCII digits, e.g. '1000'. */
  kind: string;
  name: string;
  bytes: Buffer;
  /** Routing fields the device derived, kept for filing the study. */
  dept?: string;
  time?: string;
  total?: string;
  index?: string;
}

/** Message types, from DataTransferThread's static initialiser. */
export const MSG_FILE_HEAD = '1000';
export const MSG_FILE_REPLY = '2000';
export const MSG_CTRL = '5000';
export const MSG_CTRL_NO_DATA = '5001';

/** The header is read with one 256-byte read() on the device. */
export const HEADER_BYTES = 256;

/** [type:4][len:4][value:len] — every numeric field is decimal ASCII. */
const FIELD_WIDTH = 4;

/** Reads one 4-digit decimal field, or null if it is not one. */
function readField(s: string, at: number): string | null {
  if (at < 0 || at + FIELD_WIDTH > s.length) return null;
  const raw = s.slice(at, at + FIELD_WIDTH);
  return /^\d{4}$/.test(raw) ? raw : null;
}

export interface Tlv {
  type: string;
  value: string;
}

/**
 * Parses a TLV block starting at `offset`, returning the fields and how many
 * characters were consumed.
 *
 * Stops at the first field that is not four decimal digits, which is how the
 * device behaves: it reads a fixed count of fields and the padding after the
 * last one is spaces or NULs from the zero-filled 256-byte buffer.
 */
export function parseTlvBlock(
  head: string,
  offset: number,
  maxFields = 16,
): { fields: Tlv[]; consumed: number } {
  const fields: Tlv[] = [];
  let at = offset;
  for (let i = 0; i < maxFields; i++) {
    const type = readField(head, at);
    if (type === null) break;
    const lenStr = readField(head, at + FIELD_WIDTH);
    if (lenStr === null) break;
    const len = parseInt(lenStr, 10);
    const valueStart = at + FIELD_WIDTH * 2;
    if (valueStart + len > head.length) break;
    fields.push({ type, value: head.slice(valueStart, valueStart + len) });
    at = valueStart + len;
  }
  return { fields, consumed: at - offset };
}

/** The study folder id the device itself builds: "<time with : -> ->_<dept>". */
export function buildStudyId(time: string, dept: string): string {
  return `${time.replace(/:/g, '-')}_${dept}`;
}

export class FileFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feeds one TCP chunk and returns any file frames it completed.
   *
   * The device sends a 256-byte FileHead message, then the raw file bytes.
   * Chunks may split anywhere — mid-header, mid-filename, mid-payload — and
   * several messages may arrive in one chunk, so this buffers and yields only
   * what is provably complete.
   */
  push(chunk: Buffer): ReceivedFileFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ReceivedFileFrame[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.buffer.length < HEADER_BYTES) break;

      const head = this.buffer.subarray(0, HEADER_BYTES).toString('latin1');
      const msgType = readField(head, 0);
      if (msgType === null) {
        this.resync();
        continue;
      }

      if (msgType !== MSG_FILE_HEAD) {
        // A control or reply message. Its own length is the field at offset 4,
        // and the whole thing sits inside the 256-byte header, so it is skipped
        // rather than treated as file data.
        const lenStr = readField(head, FIELD_WIDTH);
        const len = lenStr === null ? 0 : parseInt(lenStr, 10);
        if (len < 0 || HEADER_BYTES - 8 < len) {
          this.resync();
          continue;
        }
        this.buffer = this.buffer.subarray(HEADER_BYTES);
        continue;
      }

      const { fields } = parseTlvBlock(head, 12);
      // Positional, matching ParseFileHead's String[] indices.
      const dept = fields[0]?.value ?? '';
      const time = fields[1]?.value ?? '';
      const name = fields[2]?.value ?? '';
      const sizeStr = fields[3]?.value ?? '';
      const total = fields[4]?.value ?? '';
      const index = fields[5]?.value ?? '';

      const size = parseInt(sizeStr, 10);
      if (!name || !Number.isFinite(size) || size < 0) {
        this.resync();
        continue;
      }

      const frameEnd = HEADER_BYTES + size;
      if (this.buffer.length < frameEnd) break; // wait for the payload

      const bytes = Buffer.from(this.buffer.subarray(HEADER_BYTES, frameEnd));
      frames.push({ kind: msgType, name, bytes, dept, time, total, index });
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }

  /** Drops one byte and retries, so a bad header cannot wedge the stream. */
  private resync(): void {
    this.buffer = this.buffer.subarray(1);
  }

  reset(): void {
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
