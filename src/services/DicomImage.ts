/**
 * DicomImage.ts
 *
 * Decodes DICOM Image Pixel Data into 8-bit RGB frames and encodes those
 * frames as PNG bytes. Pure TypeScript â€” no native modules, no third-party
 * dependencies â€” so it runs identically under Node (tests) and React Native /
 * Hermes (device).
 *
 * ============================================================================
 * WHY THIS EXISTS ALONGSIDE DicomViewer.ts
 * ============================================================================
 * DicomViewer already rasterised uncompressed grayscale 8/16-bit files, but
 * that was not enough to display or save real ultrasound exports, for four
 * reasons found while reading the DICOM standard:
 *
 *   1. MONOCHROME1 (0028,0004) means "stored 0 is WHITE". A renderer that
 *      assumes MONOCHROME2 draws those images fully inverted. Ultrasound
 *      writes MONOCHROME1 often.
 *   2. Window Center/Width (0028,1050/1051) is the *authored* display range.
 *      DicomViewer always used a min/max window over actual pixels, which
 *      crushes any 12-bit-in-16-bit image that carries unused headroom.
 *   3. Rescale Slope/Intercept (0028,1052/1053) map stored values to physical
 *      units. With a Modality LUT present these hold the real scaling, so a VOI
 *      window is meaningless without them.
 *   4. samplesPerPixel 3 (RGB/YBR) and RLE encapsulation were refused outright,
 *      making colour and lossless-compressed exports unviewable.
 *
 * DELIBERATELY NOT INCLUDED: the JPEG family (baseline, lossless, JPEG-LS,
 * JPEG 2000). Those need a real codec; a hand-rolled baseline JPEG decoder
 * here would be large, slow and untrustworthy. Callers get an explicit
 * `reason: 'jpeg'` instead of a corrupt image.
 *
 * ============================================================================
 * DICOM FACTS USED (PS3.5 transfer syntaxes, PS3.3 image pixel module)
 * ============================================================================
 *   - Native uncompressed: 1.2.840.10008.1.2 (implicit LE), .1 (explicit LE),

/** Transfer syntaxes this module can render natively. */
export const SUPPORTED_UNCOMPRESSED = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
  '1.2.840.10008.1.2.2', // Explicit VR Big Endian
]);

export const RLE_TRANSFER_SYNTAX = '1.2.840.10008.1.2.5';
export const DEFLATED_TRANSFER_SYNTAX = '1.2.840.10008.1.2.1.99';

const JPEG_LOSSY = new Set([
  '1.2.840.10008.1.2.4.50', // JPEG baseline (process 1)
  '1.2.840.10008.1.2.4.51', // JPEG extended (process 2 & 4)
  '1.2.840.10008.1.2.4.57', // JPEG lossless, non-hierarchical (process 14)
  '1.2.840.10008.1.2.4.70', // JPEG lossless, non-hierarchical, SV1
  '1.2.840.10008.1.2.4.80', // JPEG-LS lossless
  '1.2.840.10008.1.2.4.81', // JPEG-LS near-lossless
  '1.2.840.10008.1.2.4.90', // JPEG 2000 lossless
  '1.2.840.10008.1.2.4.91', // JPEG 2000
]);

export type UnsupportedReason =
  | 'jpeg'
  | 'deflated'
  | 'unknown-syntax'
  | 'unsupported-pixel-format';

export interface DicomImageAttributes {
  rows: number;
  columns: number;
  samplesPerPixel: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: number;
  planarConfiguration: number;
  photometric: string;
  windowCenter?: number;
  windowWidth?: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  numberOfFrames: number;
  /** True when Pixel Data is undefined-length (compressed) rather than native. */
  encapsulated: boolean;
  transferSyntax?: string;
  /** Byte offset of the Pixel Data *value*, after its tag/VR/length header. */
  pixelDataOffset: number;
  /** Declared Pixel Data value length; 0xFFFFFFFF when undefined-length. */
  pixelDataLength: number;
  /** True when the Data Set is big-endian (Explicit VR Big Endian only). */
  bigEndian: boolean;
}

export interface DecodedFrame {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, row-major, first row at the top. */
  rgb: Uint8Array;
}

export type DecodeOutcome =
  | { ok: true; frames: DecodedFrame[]; attributes: DicomImageAttributes }
  | { ok: false; reason: UnsupportedReason; detail: string };

/* -------------------------------------------------------------------------- *
 * Byte and tag helpers
 * -------------------------------------------------------------------------- */

function readU16(b: Uint8Array, off: number, le: boolean): number {
  if (le) return ((b[off + 1] ?? 0) << 8) | (b[off] ?? 0);
  return ((b[off] ?? 0) << 8) | (b[off + 1] ?? 0);
}

function readU32(b: Uint8Array, off: number, le: boolean): number {
  if (le) {
    return (
      (((b[off + 3] ?? 0) << 24) |
        ((b[off + 2] ?? 0) << 16) |
        ((b[off + 1] ?? 0) << 8) |
        (b[off] ?? 0)) >>>
      0
    );
  }
  return (
    (((b[off] ?? 0) << 24) |
      ((b[off + 1] ?? 0) << 16) |
      ((b[off + 2] ?? 0) << 8) |
      (b[off + 3] ?? 0)) >>>
    0
  );
}

/** DICOM DS â€” decimal string, may hold backslash-separated values. */
function parseDecimalString(s: string): number[] {
  return s
    .split('\\')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
}

/** Reads `len` bytes as latin1, trimming DICOM's trailing padding. */

/* -------------------------------------------------------------------------- *
 * Attribute scanning
 * -------------------------------------------------------------------------- */

/**
 * Walks the Data Set and returns the image attributes plus the location of
 * Pixel Data. Never throws: a malformed stream yields whatever was read with
 * `pixelDataOffset: 0`, which callers treat as "no image".
 *
 * Byte order comes from the Transfer Syntax UID read out of the File Meta
 * Information, not from a heuristic probe â€” the previous parser in
 * DicomService sniffed a group-length element, which cannot distinguish
 * Explicit VR Big Endian from Explicit VR Little Endian.
 */
export function readDicomImageAttributes(
  bytes: Uint8Array,
): DicomImageAttributes | null {
  if (bytes.length < 132) return null;
  if (readString(bytes, 128, 4) !== 'DICM') return null;

  // PS3.10: File Meta Information (group 0002) is always Explicit VR LE and
  // always begins with a group length element (0002,0000).
  const cursor = 132;
  if (readU16(bytes, cursor, true) !== 0x0002 || readU16(bytes, cursor + 2, true) !== 0x0000) {
    return null;
  }
  // (0002,0000) has VR 'UL': a SHORT-form element, tag(4) + VR(2) + length(2) +
  // value(4), so the value is the uint32 at cursor+8 and the next element starts
  // at cursor+12. Note that UL is NOT in LONG_FORM_VR despite its 4-byte value.
  const metaLen = readU32(bytes, cursor + 8, true);
  const metaEnd = cursor + 12 + metaLen;
  if (metaEnd > bytes.length) return null;

  let transferSyntax: string | undefined;
  {
    let p = cursor + 12;
    while (p + 8 <= metaEnd) {
      const g = readU16(bytes, p, true);
      const e = readU16(bytes, p + 2, true);
      const vr = readString(bytes, p + 4, 2);
      let vlen: number;
      let voff: number;
      if (LONG_FORM_VR.has(vr)) {
        vlen = readU32(bytes, p + 8, true);
        voff = p + 12;
      } else {
        vlen = readU16(bytes, p + 6, true);
        voff = p + 8;
      }
      if (g === 0x0002 && e === 0x0010) {
        transferSyntax = readString(bytes, voff, vlen);
      }
      if (vlen === 0xffffffff) break;
      p = voff + vlen + (vlen % 2);
    }
  }

  const bigEndian = transferSyntax === '1.2.840.10008.1.2.2';
  const explicit = transferSyntax !== '1.2.840.10008.1.2';
  const le = !bigEndian;

  const attrs: DicomImageAttributes = {
    rows: 0,
    columns: 0,
    samplesPerPixel: 1,
    bitsAllocated: 0,
    bitsStored: 0,
    pixelRepresentation: 0,
    planarConfiguration: 0,
    photometric: 'MONOCHROME2',
    rescaleSlope: 1,
    rescaleIntercept: 0,
    numberOfFrames: 1,
    encapsulated: false,
    transferSyntax,
    pixelDataOffset: 0,
    pixelDataLength: 0,
    bigEndian,
  };

  let off = metaEnd;
  const len = bytes.length;
  let guard = 0;

  while (off + 8 <= len && guard++ < 65536) {
    const g = readU16(bytes, off, le);
    const e = readU16(bytes, off + 2, le);

    // Item / delimiter tags: (FFFE,xxxx) inside a sequence.
    if (g === 0xfffe) {
      const itemLen = readU32(bytes, off + 4, le);
      if (itemLen === 0xffffffff) return attrs; // undefined-length item
      off += 8 + itemLen;
      continue;
    }

    const vr = readString(bytes, off + 4, 2);
    let valueLen: number;
    let valueOff: number;
    if (explicit && LONG_FORM_VR.has(vr)) {
      valueLen = readU32(bytes, off + 8, le);
      valueOff = off + 12;
    } else if (explicit) {
      valueLen = readU16(bytes, off + 6, le);
      valueOff = off + 8;
    } else {
      valueLen = readU32(bytes, off + 4, le);
      valueOff = off + 8;
    }

    // Group-length elements (gggg,0000) carry no image information.
    if (e === 0x0000) {
      if (valueLen === 0xffffffff) return attrs;
      off = valueOff + valueLen + (valueLen % 2);
      continue;
    }

    switch (g * 0x10000 + e) {
      case 0x00280002: attrs.samplesPerPixel = readU16(bytes, valueOff, le) || 1; break;
      case 0x00280004: attrs.photometric = readString(bytes, valueOff, valueLen).toUpperCase(); break;
      case 0x00280006: attrs.planarConfiguration = readU16(bytes, valueOff, le); break;
      case 0x00280008:
        attrs.numberOfFrames = parseInt(readString(bytes, valueOff, valueLen), 10) || 1;
        break;
      case 0x00280010: attrs.rows = readU16(bytes, valueOff, le); break;
      case 0x00280011: attrs.columns = readU16(bytes, valueOff, le); break;
      case 0x00280100: attrs.bitsAllocated = readU16(bytes, valueOff, le); break;
      case 0x00280101: attrs.bitsStored = readU16(bytes, valueOff, le); break;
      case 0x00280103: attrs.pixelRepresentation = readU16(bytes, valueOff, le); break;
      case 0x00281050: {
        const v = parseDecimalString(readString(bytes, valueOff, valueLen));
        if (v.length) attrs.windowCenter = v[0];
        break;
      }
      case 0x00281051: {
        const v = parseDecimalString(readString(bytes, valueOff, valueLen));
        if (v.length) attrs.windowWidth = v[0];
        break;
      }
      case 0x00281052:
        attrs.rescaleIntercept = parseDecimalString(readString(bytes, valueOff, valueLen))[0] ?? 0;
        break;
      case 0x00281053:
        attrs.rescaleSlope = parseDecimalString(readString(bytes, valueOff, valueLen))[0] ?? 1;
        break;
      case 0x7fe00010:
        attrs.pixelDataOffset = valueOff;
        attrs.pixelDataLength = valueLen;
        attrs.encapsulated = valueLen === 0xffffffff;
        return attrs; // everything past Pixel Data is bulk data
      default:
        break;
    }

    if (valueLen === 0xffffffff) return attrs;
    off = valueOff + valueLen + (valueLen % 2);
  }

  return attrs;
}

/**
 * Reads `len` bytes as latin1, trimming DICOM's trailing padding.
 *
 * PS3.5 pads odd-length values to an even length: text VRs with a space, and
 * UIDs with a NUL byte. JavaScript's trim() does not consider \0 whitespace, so
 * without the explicit strip a padded UID comes back as "1.2.840...1.2.1\0" and
 * matches no Transfer Syntax in the supported set.
 */
function readString(b: Uint8Array, off: number, len: number): string {
  const end = Math.min(b.length, off + Math.max(0, len));
  let s = '';
  for (let i = off; i < end; i++) {
    const c = b[i]!;
    if (c === 0) break; // NUL padding terminates the value
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/* -------------------------------------------------------------------------- *
 * RLE (TIFF PackBits variant) â€” PS3.5 Annex A.5
 * -------------------------------------------------------------------------- */

/**
 * Decodes one RLE-encoded frame back to its native bytes.
 *
 * Each non-empty plane expands to exactly `expectedBytes` bytes, and the planes
 * are concatenated in segment order. For an 8-bit image that means byte 0 comes
 * from plane 1, byte 1 from plane 2, and byte 2 from plane 3 — so an RGB image
 * reassembles correctly without per-plane special casing.
 *
 * Header is 120 bytes: fifteen uint32 segment counts, then fifteen uint32
 * offsets. Count N says byte plane N holds N PackBits segments; plane 0 is
 * unused. Offsets are relative to the start of the frame. PackBits control
 * byte n: 0..127 copies the next n+1 literals, -1..-127 repeats the next byte
 * (1-n) times, -128 is a no-op.
 */
function decodeRleFrame(frame: Uint8Array, expectedBytes: number): Uint8Array | null {
  if (frame.length < 120) return null;
  if (readU32(frame, 0, true) !== 15) return null;

  const out = new Uint8Array(expectedBytes);
  let produced = 0;

  for (let seg = 1; seg < 15; seg++) {
    const count = readU32(frame, 4 + seg * 4, true);
    if (count === 0) continue;
    const offset = readU32(frame, 64 + seg * 4, true);
    if (offset >= frame.length) return null;

    // This plane contributes exactly one frame's worth of bytes, and its
    // segments start at its own offset rather than where the last plane ended.
    const planeEnd = produced + expectedBytes;
    let p = offset;

    for (let s = 0; s < count && produced < planeEnd; s++) {
      while (p < frame.length && produced < planeEnd) {
        const n = (frame[p]! << 24) >> 24; // sign-extend int8
        p++;
        if (n >= 0) {
          const run = n + 1;
          for (let i = 0; i < run && produced < planeEnd; i++) {
            out[produced++] = frame[p++] ?? 0;
          }
        } else if (n !== -128) {
          const run = 1 - n;
          const value = frame[p++] ?? 0;
          for (let i = 0; i < run && produced < planeEnd; i++) {
            out[produced++] = value;
          }
        }
      }
    }
  }

  return produced === expectedBytes ? out : null;
}

/* -------------------------------------------------------------------------- *
 * Encapsulated fragments
 * -------------------------------------------------------------------------- */

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Splits encapsulated (undefined-length) Pixel Data into per-frame bytes.
 *
 * Each fragment header is tag(4) + length(4) in stream byte order. The first
 * (FFFE,E000) fragment is the Basic Offset Table and carries no image data;
 * the rest are image fragments. Frames are separated by even byte count, and
 * when NumberOfFrames > 1 the fragments are split evenly, because devices
 * commonly leave the offset table empty.
 */
function splitEncapsulatedFrames(
  bytes: Uint8Array,
  start: number,
  le: boolean,
  frameCount: number,
): Uint8Array[] | null {
  const raw: Uint8Array[] = [];
  let off = start;
  let sawOffsetTable = false;
  let guard = 0;

  while (off + 8 <= bytes.length && guard++ < 100000) {
    const g = readU16(bytes, off, le);
    const e = readU16(bytes, off + 2, le);
    const fragLen = readU32(bytes, off + 4, le);

    if (g === 0xfffe && e === 0xe0dd) break; // sequence delimiter
    if (fragLen === 0xffffffff) break;

    const dataOff = off + 8;
    if (dataOff + fragLen > bytes.length) break;

    if (g === 0xfffe && e === 0xe000) {
      if (!sawOffsetTable) {
        sawOffsetTable = true; // basic offset table, discard
      } else {
        raw.push(bytes.subarray(dataOff, dataOff + fragLen));
      }
    } else if (g === 0xfffe && e === 0xe00d) {
      break; // item delimiter
    }
    off = dataOff + fragLen + (fragLen % 2);
  }

  if (raw.length === 0) return null;
  if (frameCount <= 1) return [concat(raw)];

  const perFrame = Math.floor(raw.length / frameCount);
  if (perFrame <= 0) return null;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(concat(raw.slice(i * perFrame, (i + 1) * perFrame)));
  }
  return frames;
}

/** VRs that use the 12-byte long form: tag(4) + VR(2) + reserved(2) + len(4). */
const LONG_FORM_VR = new Set([
  'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN',
]);

/* -------------------------------------------------------------------------- *
 * Samples to RGB
 * -------------------------------------------------------------------------- */

const YBR_FULL = new Set(['YBR_FULL', 'YBR_FULL_422', 'YBR_PARTIAL_422', 'YBR_RCT']);

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Builds the VOI transform for a frame.
 *
 * With an authored Window Center/Width the stored range is mapped into that
 * window (PS3.3 C.11.2.1.2: width-1 below centre, width-1 at or above).
 * Without one we fall back to the frame's own min/max, which is what
 * DicomViewer did unconditionally.
 */
function makeWindow(
  wc: number | undefined,
  ww: number | undefined,
  min: number,
  max: number,
): (stored: number) => number {
  if (wc === undefined || ww === undefined || ww <= 0) {
    const range = Math.max(1, max - min);
    return (v) => clamp255(((v - min) / range) * 255);
  }
  const c = wc - 0.5;
  const low = c - (ww - 1) / 2;
  const high = c + (ww - 1) / 2;
  const range = Math.max(1e-6, high - low);
  return (v) => clamp255(((v - low) / range) * 255);
}

function rangeOf(values: Int32Array): { min: number; max: number } {
  let min = Number.MAX_SAFE_INTEGER;
  let max = -Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

/**
 * Expands packed pixel bytes into one signed/unsigned int per sample, masking
 * to BitsStored when it is smaller than BitsAllocated (DICOM stores the value
 * right-aligned inside the allocated word, so a 12-bit-in-16-bit export needs
 * masking before the sign is applied).
 */
function expandSamples(
  raw: Uint8Array,
  attrs: DicomImageAttributes,
  signed: boolean,
  le: boolean,
): Int32Array {
  const { rows, columns, samplesPerPixel, bitsAllocated, bitsStored } = attrs;
  const count = rows * columns;
  const out = new Int32Array(count * samplesPerPixel);
  const depth = bitsAllocated;
  const mask = bitsStored > 0 && bitsStored < depth ? (1 << bitsStored) - 1 : 0;
  const signBit = bitsStored > 0 ? 1 << (bitsStored - 1) : 0;

  for (let i = 0; i < out.length; i++) {
    if (depth === 1) {
      out[i] = (raw[i >> 3]! >> (7 - (i & 7))) & 1;
      continue;
    }
    const at = i * (depth / 8);
    // An 8-bit sample is ONE byte. Reading it as a 16-bit little-endian word
    // would consume the next pixel's byte as the high half, shifting every
    // sample by one position and destroying the image.
    let v: number;
    if (depth === 8) {
      v = raw[at] ?? 0;
    } else {
      v = le
        ? (((raw[at + 1] ?? 0) << 8) | (raw[at] ?? 0))
        : (((raw[at] ?? 0) << 8) | (raw[at + 1] ?? 0));
    }
    if (signed && depth === 16) v = (v << 16) >> 16;
    else if (signed && depth === 8) v = (v << 24) >> 24;
    if (mask) {
      v &= mask;
      if (signed && v & signBit) v -= signBit << 1;
    }
    out[i] = v;
  }
  return out;
}

/** Converts one frame of expanded samples into interleaved RGB. */
function frameToRgb(
  samples: Int32Array,
  attrs: DicomImageAttributes,
  min: number,
  max: number,
): Uint8Array {
  const { rows, columns, samplesPerPixel, photometric } = attrs;
  const count = rows * columns;
  const rgb = new Uint8Array(count * 3);

  if (samplesPerPixel >= 3) {
    const planar = attrs.planarConfiguration === 1;
    const ybr = YBR_FULL.has(photometric);
    // YBR_RCT stores full-range luma, where 0 means white.
    const invertLuma = photometric === 'YBR_RCT';

    for (let i = 0; i < count; i++) {
      let r: number;
      let g: number;
      let b: number;
      if (planar) {
        r = samples[i]!;
        g = samples[count + i]!;
        b = samples[2 * count + i]!;
      } else {
        r = samples[i * 3]!;
        g = samples[i * 3 + 1]!;
        b = samples[i * 3 + 2]!;
      }

      if (ybr) {
        // BT.601 integer approximation, PS3.3 C.7.6.3.1.2.
        const cb = g - 128;
        const cr = b - 128;
        const y = r;
        r = y + ((91881 * cr) >> 16);
        g = y - ((22554 * cb + 46802 * cr) >> 16);
        b = y + ((116130 * cb) >> 16);
      }

      rgb[i * 3] = clamp255(invertLuma ? 255 - r : r);
      rgb[i * 3 + 1] = clamp255(g);
      rgb[i * 3 + 2] = clamp255(invertLuma ? 255 - b : b);
    }
    return rgb;
  }

  // Grayscale: modality LUT (slope/intercept) then VOI window.
  const slope = attrs.rescaleSlope || 1;
  const intercept = attrs.rescaleIntercept || 0;
  const hasWindow =
    attrs.windowCenter !== undefined && attrs.windowWidth !== undefined && attrs.windowWidth > 0;

  // Window values are physical units, so compare against the rescaled range.
  const window = hasWindow
    ? makeWindow(attrs.windowCenter, attrs.windowWidth, min * slope + intercept, max * slope + intercept)
    : makeWindow(undefined, undefined, min, max);

  // MONOCHROME1 stores "1" as the low sample, so the image must be inverted.
  const invert = attrs.photometric === 'MONOCHROME1';
  for (let i = 0; i < count; i++) {
    const stored = samples[i]! * slope + intercept;
    const v = window(stored);
    rgb[i * 3] = invert ? 255 - v : v;
    rgb[i * 3 + 1] = invert ? 255 - v : v;
    rgb[i * 3 + 2] = invert ? 255 - v : v;
  }
  return rgb;
}

/* -------------------------------------------------------------------------- *
 * Public decode entry point
 * -------------------------------------------------------------------------- */

/**
 * Decodes a DICOM file into RGB frames.
 *
 * Returns a discriminated union rather than throwing: this is called from an
 * import/scan flow, where the right response to an undecodable file is to say
 * why, not to crash the app.
 */
export function decodeDicomToRgb(bytes: Uint8Array): DecodeOutcome {
  const attrs = readDicomImageAttributes(bytes);
  if (!attrs) {
    return {
      ok: false,
      reason: 'unknown-syntax',
      detail: 'Not a DICOM file (no DICM magic at offset 128).',
    };
  }

  const ts = attrs.transferSyntax;
  if (ts && JPEG_LOSSY.has(ts)) {
    return {
      ok: false,
      reason: 'jpeg',
      detail: `${ts} needs a JPEG codec, which this dependency-free decoder does not include.`,
    };
  }
  if (ts === DEFLATED_TRANSFER_SYNTAX) {
    return {
      ok: false,
      reason: 'deflated',
      detail: 'Deflated Explicit VR Little Endian needs an inflate implementation.',
    };
  }
  if (ts && !SUPPORTED_UNCOMPRESSED.has(ts) && ts !== RLE_TRANSFER_SYNTAX) {
    return { ok: false, reason: 'unknown-syntax', detail: `Unsupported transfer syntax ${ts}.` };
  }

  const { rows, columns, samplesPerPixel, bitsAllocated, numberOfFrames } = attrs;
  if (!rows || !columns) {
    return { ok: false, reason: 'unsupported-pixel-format', detail: 'Missing Rows/Columns.' };
  }
  if (bitsAllocated !== 1 && bitsAllocated !== 8 && bitsAllocated !== 16) {
    return {
      ok: false,
      reason: 'unsupported-pixel-format',
      detail: `BitsAllocated ${bitsAllocated} is not supported (need 1, 8 or 16).`,
    };
  }
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3) {
    return {
      ok: false,
      reason: 'unsupported-pixel-format',
      detail: `SamplesPerPixel ${samplesPerPixel} is not supported (need 1 or 3).`,
    };
  }
  if (attrs.pixelDataOffset === 0) {
    return {
      ok: false,
      reason: 'unsupported-pixel-format',
      detail: 'No Pixel Data (7FE0,0010) found.',
    };
  }

  const signed = attrs.pixelRepresentation === 1;
  const le = !attrs.bigEndian;
  const nativeFrameBytes = rows * columns * samplesPerPixel * (bitsAllocated / 8);

  // ---------------- encapsulated (RLE) ----------------
  if (attrs.encapsulated) {
    if (ts !== RLE_TRANSFER_SYNTAX) {
      return {
        ok: false,
        reason: 'jpeg',
        detail: `Encapsulated pixel data in ${ts ?? 'an unstated syntax'}.`,
      };
    }
    const frags = splitEncapsulatedFrames(bytes, attrs.pixelDataOffset, le, numberOfFrames);
    if (!frags || frags.length === 0) {
      return {
        ok: false,
        reason: 'unsupported-pixel-format',
        detail: 'No encapsulated frame fragments found.',
      };
    }
    const frames: DecodedFrame[] = [];
    for (const frag of frags) {
      const native = decodeRleFrame(frag, nativeFrameBytes);
      if (!native) {
        return { ok: false, reason: 'unsupported-pixel-format', detail: 'Malformed RLE frame.' };
      }
      const expanded = expandSamples(native, attrs, signed, le);
      const { min, max } = rangeOf(expanded);
      frames.push({ width: columns, height: rows, rgb: frameToRgb(expanded, attrs, min, max) });
    }
    return { ok: true, frames, attributes: attrs };
  }

  // ---------------- native uncompressed ----------------
  const total = nativeFrameBytes * numberOfFrames;
  const available = bytes.length - attrs.pixelDataOffset;
  if (available < total) {
    return {
      ok: false,
      reason: 'unsupported-pixel-format',
      detail: `Pixel Data truncated: need ${total} bytes, have ${available}.`,
    };
  }

  // Expand every frame first, then take ONE min/max across the whole clip.
  // Windowing per frame would make brightness pump between cine frames of the
  // same study, because ultrasound frames have different amounts of speckle.
  const expanded: Int32Array[] = [];
  for (let f = 0; f < numberOfFrames; f++) {
    const at = attrs.pixelDataOffset + f * nativeFrameBytes;
    expanded.push(expandSamples(bytes.subarray(at, at + nativeFrameBytes), attrs, signed, le));
  }
  const all = new Int32Array(total === 0 ? 1 : expanded.length * rows * columns * samplesPerPixel);
  let cursor = 0;
  for (const e of expanded) {
    all.set(e, cursor);
    cursor += e.length;
  }
  const { min, max } = rangeOf(all);

  const frames: DecodedFrame[] = [];
  for (const e of expanded) {
    frames.push({ width: columns, height: rows, rgb: frameToRgb(e, attrs, min, max) });
  }
  return { ok: true, frames, attributes: attrs };
}

/* -------------------------------------------------------------------------- *
 * PNG encoding
 * -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/**
 * Encodes an RGB buffer as a PNG byte stream.
 *
 * Uses zlib "stored" (uncompressed) deflate blocks, which keeps the encoder
 * small and dependency-free. The file is larger than a real deflate stream but
 * is a fully valid PNG that the gallery and every viewer accepts. Ultrasound
 * frames are mostly black with a bright sector, so real compression would help
 * a lot â€” but correctness beats size, and a hand-rolled Huffman stage is not
 * worth the risk here.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const out: number[] = [];
  const push = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i++) out.push(arr[i]! & 0xff);
  };
  // A chunk is length(4) + type(4) + data + crc(4), where the CRC covers the
  // type AND the data. Writing it any other way produces a file that decoders
  // silently reject, so it is worth building once here.
  const chunk = (type: string, data: Uint8Array) => {
    const t = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
    const body = Uint8Array.from([...t, ...data]);
    push(u32be(data.length));
    push(body);
    push(u32be(crc32(body)));
  };

  // PNG signature
  push([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth 8, colour type 2 (truecolour RGB).
  chunk('IHDR', Uint8Array.from([...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]));

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const rowBytes = width * 3;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1);
    raw[at] = 0;
    raw.set(rgb.subarray(y * rowBytes, (y + 1) * rowBytes), at + 1);
  }

  // zlib stream: a 2-byte header, stored (uncompressed) deflate blocks, then a
  // 4-byte Adler-32 trailer. Note the trailer is ONE uint32 (s << 16 | a) sent
  // big-endian, not two separate 32-bit halves.
  const idat: number[] = [0x78, 0x01];
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  for (let b = 0; b < numBlocks; b++) {
    const start = b * maxBlock;
    const len = Math.min(maxBlock, raw.length - start);
    // LEN and its one's complement NLEN, both little-endian (DEFLATE stored).
    idat.push(b === numBlocks - 1 ? 1 : 0); // BFINAL, BTYPE=00
    idat.push(len & 0xff, (len >>> 8) & 0xff);
    idat.push(~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) idat.push(raw[start + i]!);
  }

  let a = 1;
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    s = (s + a) % 65521;
  }
  const adler = ((s << 16) | a) >>> 0;
  idat.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);

  chunk('IDAT', Uint8Array.from(idat));

  // IEND carries no data.
  chunk('IEND', new Uint8Array(0));

  return Uint8Array.from(out);
}

/** Decodes and PNG-encodes frame `index` in one step. Returns null on failure. */
export function dicomFrameToPng(bytes: Uint8Array, index = 0): Uint8Array | null {
  const result = decodeDicomToRgb(bytes);
  if (!result.ok) return null;
  const frame = result.frames[index];
  if (!frame) return null;
  return encodePng(frame.width, frame.height, frame.rgb);
}
