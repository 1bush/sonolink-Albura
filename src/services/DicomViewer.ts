/**
 * DicomViewer.ts
 *
 * Pure-JS rasteriser for UNCOMPRESSED single-frame grayscale DICOM — the
 * format SonoScape ultrasound exports use with the default transfer syntaxes
 * (implicit/explicit VR little-endian, 1.2.840.10008.1.2 / .1 / .2).
 *
 * Output: an 8-bit paletted BMP encoded as a `data:image/bmp;base64,...` URI.
 * React Native's Image renders BMP natively on Android and iOS, so no native
 * module or extra dependency is needed.
 *
 * Supported inputs (anything else returns null and the caller keeps the
 * placeholder UI):
 *   - samplesPerPixel = 1 (grayscale)
 *   - bitsAllocated = 8 or 16, signed or unsigned
 *   - no encapsulated pixel data (JPEG/deflated transfer syntaxes are refused)
 *
 * Contrast: min/max windowing across the pixel buffer, mapped linearly onto
 * the 0..255 range — adequate for ultrasound preview purposes.
 */
import { Buffer } from 'buffer';
import { DicomService, type DicomMetadata } from './DicomService';

/** Compressed transfer syntaxes this rasteriser cannot handle. */
const UNSUPPORTED_SYNTAXES = new Set([
  '1.2.840.10008.1.2.4.50', // JPEG baseline
  '1.2.840.10008.1.2.4.51', // JPEG extended
  '1.2.840.10008.1.2.4.57', // JPEG lossless
  '1.2.840.10008.1.2.4.70', // JPEG lossless SV1
  '1.2.840.10008.1.2.4.80', // JPEG-LS
  '1.2.840.10008.1.2.4.81', // JPEG-LS lossless
  '1.2.840.10008.1.2.4.90', // JPEG 2000
  '1.2.840.10008.1.2.4.91', // JPEG 2000 lossless
  '1.2.840.10008.1.2.5',    // RLE
  '1.2.840.10008.1.2.1.99', // Deflated
]);

export interface DicomRenderResult {
  uri: string;
  meta: DicomMetadata;
}

function buildBmp(width: number, height: number, gray: Uint8Array): string {
  const rowSize = Math.ceil(width / 4) * 4; // rows padded to 4 bytes
  const pixelBytes = rowSize * height;
  const paletteBytes = 256 * 4;
  const fileHeaderLen = 14;
  const infoHeaderLen = 40;
  const dataOffset = fileHeaderLen + infoHeaderLen + paletteBytes;
  const total = dataOffset + pixelBytes;

  const out = Buffer.alloc(total, 0);

  // BITMAPFILEHEADER
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(total, 2);
  out.writeUInt32LE(dataOffset, 10);

  // BITMAPINFOHEADER
  out.writeUInt32LE(infoHeaderLen, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // positive → bottom-up rows
  out.writeUInt16LE(1, 26);     // planes
  out.writeUInt16LE(8, 28);     // bpp (palette)
  out.writeUInt32LE(0, 30);     // compression: BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeUInt32LE(0, 46);     // colors used: 256

  // Greyscale palette.
  for (let i = 0; i < 256; i++) {
    const p = 54 + i * 4;
    out[p] = i; out[p + 1] = i; out[p + 2] = i; out[p + 3] = 0;
  }

  // Pixel rows, bottom-up, padded.
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    const dstRow = dataOffset + y * rowSize;
    for (let x = 0; x < width; x++) {
      out[dstRow + x] = gray[srcRow + x] ?? 0;
    }
  }

  return `data:image/bmp;base64,${out.toString('base64')}`;
}

/**
 * Rasterise an uncompressed grayscale DICOM buffer into a displayable BMP
 * data URI. Returns null for compressed/RGB/unsupported inputs — callers
 * should keep their placeholder UI in that case.
 */
export function renderDicomToBmpDataUri(bytes: Uint8Array): DicomRenderResult | null {
  const meta = DicomService.parse(bytes);
  if (!meta) return null;

  if (
    meta.transferSyntax !== undefined &&
    UNSUPPORTED_SYNTAXES.has(meta.transferSyntax.trim())
  ) return null;

  const { rows, columns } = meta;
  const samples = meta.samplesPerPixel ?? 1;
  const bits = meta.bitsAllocated ?? (samples === 1 ? 16 : 8);
  if (!rows || !columns || samples !== 1 || (bits !== 8 && bits !== 16)) return null;
  if (meta.pixelDataOffset === undefined || meta.pixelDataLength === undefined) return null;

  const signed = meta.pixelRepresentation === 1;
  const b = bytes;
  const count = rows * columns;
  const bytesPerSample = bits / 8;

  if (meta.pixelDataOffset + count * bytesPerSample > b.length) return null;

  // Single pass: read samples, track min/max for the window.
  const samplesOut = new Int32Array(count);
  let min = Number.MAX_SAFE_INTEGER;
  let max = Number.MIN_SAFE_INTEGER;
  for (let i = 0; i < count; i++) {
    const off = meta.pixelDataOffset + i * bytesPerSample;
    let v: number;
    if (bits === 8) {
      v = signed ? ((b[off]! << 24) >> 24) : b[off]!;
    } else {
      const lo = b[off]!, hi = b[off + 1]!;
      v = lo | (hi << 8); // little-endian sample (ultrasound default)
      if (signed) v = (v << 16) >> 16;
    }
    samplesOut[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Linear min/max window → 0..255.
  const range = Math.max(1, max - min);
  const gray = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    gray[i] = Math.round(((samplesOut[i] - min) / range) * 255);
  }

  return { uri: buildBmp(columns, rows, gray), meta };
}