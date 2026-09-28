/**
 * DicomService.ts
 *
 * Minimal, defensive DICOM header parser used by SonoLink when a received
 * frame is a DICOM file (e.g. `*.dcm` / `DICOM`). It walks the DICOM element
 * stream and reads the fields the album UI wants:
 *   - patient name / ID
 *   - modality (e.g. US for ultrasound)
 *   - study / series / SOP instance UID
 *   - rows / columns / samples per pixel
 *   - pixel data location (offset + length)
 *
 * It is deliberately read-only and NEVER throws: malformed input returns
 * `null` (or best-effort partial data) instead of crashing the scan flow.
 *
 * Handles both Explicit-VR and Implicit-VR streams, and both byte orders
 * (as signalled by the group-length element). Stops early at the sequence
 * delimiter so it never overruns the buffer.
 */
import { Buffer } from 'buffer';

export interface DicomMetadata {
  patientName?: string;
  patientId?: string;
  modality?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  rows?: number;
  columns?: number;
  samplesPerPixel?: number;
  /** Bits per pixel sample (0028,0100) — 8 or 16 for uncompressed ultrasound. */
  bitsAllocated?: number;
  /** 0 = unsigned, 1 = two's complement signed (0028,0103). */
  pixelRepresentation?: number;
  transferSyntax?: string;
  pixelDataOffset?: number;
  pixelDataLength?: number;
  endian: 'little' | 'big';
  vrStyle: 'explicit' | 'implicit';
}

const KNOWN_VR = new Set([
  'AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT',
  'OB', 'OD', 'OF', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'TM', 'UI',
  'UL', 'US', 'UT', 'UN',
]);

function readU16(b: Uint8Array, off: number, le: boolean): number {
  if (le) return ((b[off + 1] ?? 0) << 8) | (b[off] ?? 0);
  return ((b[off] ?? 0) << 8) | (b[off + 1] ?? 0);
}

function readU32(b: Uint8Array, off: number, le: boolean): number {
  if (le) {
    return (
      ((b[off + 3] ?? 0) << 24) |
      ((b[off + 2] ?? 0) << 16) |
      ((b[off + 1] ?? 0) << 8) |
      (b[off] ?? 0)
    );
  }
  return (
    ((b[off] ?? 0) << 24) |
    ((b[off + 1] ?? 0) << 16) |
    ((b[off + 2] ?? 0) << 8) |
    (b[off + 3] ?? 0)
  );
}

function group(b: Uint8Array, off: number, le: boolean): number {
  return le ? readU16(b, off, true) : readU16(b, off, false);
}

// DICOM tag is a 32-bit (group, element) pair stored little-endian: the FIRST
// 2 bytes are the group, the next 2 the element. The canonical tag string
// form is "GGGGEEEE" (e.g. patient name (0010,0010) → "00100010").
function tagString(g: number, e: number): string {
  return g.toString(16).padStart(4, '0').toUpperCase() + e.toString(16).padStart(4, '0').toUpperCase();
}

export class DicomService {
  /** Parse a DICOM file buffer. Returns null if it does not look like DICOM. */
  static parse(input: Uint8Array | Buffer): DicomMetadata | null {
    const b: Uint8Array = input instanceof Buffer ? Uint8Array.from(input) : input;
    if (b.length < 132) return null;
    // 128-byte preamble + "DICM" magic.
    const magic = String.fromCharCode(b[128] ?? 0, b[129] ?? 0, b[130] ?? 0, b[131] ?? 0);
    if (magic !== 'DICM') return null;

    let le = true;        // default little-endian
    let explicit = true;  // default explicit VR
    const meta: DicomMetadata = { endian: 'little', vrStyle: 'explicit' };

    let off = 132;
    const len = b.length;
    let transformed = false;

    for (let i = 0; i < 8192 && off + 8 <= len; i++) {
      const g = group(b, off, le);
      const e = group(b, off + 2, le);

      // First element (0000,0000) group length: detect byte order + VR style.
      if (g === 0x0000 && e === 0x0000 && !transformed) {
        const probe = String.fromCharCode(b[off + 4] ?? 0, b[off + 5] ?? 0);
        if (!KNOWN_VR.has(probe)) {
          // Meta-group header is usually explicit; but if the VR bytes look
          // like raw length data, treat the stream as implicit little-endian.
          const longWord = readU32(b, off + 4, true);
          explicit = longWord < 0xffffffff && probe !== 'UN';
          le = true;
        }
        transformed = true;
      }

      const vr = String.fromCharCode(b[off + 4] ?? 0, b[off + 5] ?? 0);
      const knownVr = KNOWN_VR.has(vr);
      let valueLen: number;
      let valueOff: number;

      if (explicit) {
        if (!knownVr || vr === 'OB' || vr === 'OW' || vr === 'OF' || vr === 'OD' || vr === 'SQ' || vr === 'UT' || vr === 'UN') {
          // Long form: tag(4) + VR(2) + reserved(2) + length(4) + value.
          valueLen = readU32(b, off + 8, le);
          valueOff = off + 12;
        } else {
          // Short form: tag(4) + VR(2) + length(2) + value.
          valueLen = readU16(b, off + 6, le);
          valueOff = off + 8;
        }
      } else {
        // Implicit VR: tag(4) + length(4) + value.
        valueLen = readU32(b, off + 4, le);
        valueOff = off + 8;
      }

      // Sequence delimiter (FFFE,E0DD) → end of sequence/this element run.
      if (g === 0xe0dd && e === 0xfffe) break;
      if (valueLen === 0xffffffff) break;
      if (valueOff + valueLen > len) break;

      const tag = tagString(g, e);
      const readStr = (): string | undefined => {
        let end = valueOff + valueLen;
        while (end > valueOff && (b[end - 1] === 0 || b[end - 1] === 0x20)) end--;
        return String.fromCharCode(...b.slice(valueOff, end));
      };

      switch (tag) {
        case '00100010': meta.patientName = readStr(); break;
        case '00100020': meta.patientId = readStr(); break;
        case '00080060': meta.modality = readStr(); break;
        case '0020000D': meta.studyInstanceUid = readStr(); break;
        case '0020000E': meta.seriesInstanceUid = readStr(); break;
        case '00080018': meta.sopInstanceUid = readStr(); break;
        case '00020010': meta.transferSyntax = readStr(); break;
        case '00280010': meta.rows = readU16(b, valueOff, le); break;
        case '00280011': meta.columns = readU16(b, valueOff, le); break;
        case '00280002': meta.samplesPerPixel = readU16(b, valueOff, le); break;
        case '00280100': meta.bitsAllocated = readU16(b, valueOff, le); break;
        case '00280103': meta.pixelRepresentation = readU16(b, valueOff, le); break;
        case '7FE00010':
          meta.pixelDataOffset = valueOff;
          meta.pixelDataLength = valueLen;
          break;
        default:
          break;
      }

      off = valueOff + valueLen + (valueLen % 2);
    }

    meta.endian = le ? 'little' : 'big';
    meta.vrStyle = explicit ? 'explicit' : 'implicit';
    return meta;
  }

  static parseBuffer(buf: Buffer): DicomMetadata | null {
    return DicomService.parse(buf);
  }
}
