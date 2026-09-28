/**
 * Test for DicomViewer: builds a synthetic uncompressed 16-bit DICOM,
 * rasterises it to a BMP data URI and validates the output.
 * Run: node scripts/dicom-viewer-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'DicomViewer.js'))) {
  console.log('(compiling DICOM services to .tmp-test-build/...)');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/services/DicomService.ts',
    'src/services/DicomViewer.ts',
    '--outDir', OUT,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--skipLibCheck',
    '--moduleResolution', 'node',
  ], { cwd: ROOT, stdio: 'inherit' });
}

// Buffer polyfill for Node (the TS services import the npm 'buffer' package —
// that resolves fine in Node, no action needed).

const { DicomService } = require(path.join(OUT, 'DicomService.js'));
const { renderDicomToBmpDataUri } = require(path.join(OUT, 'DicomViewer.js'));

// ── Build a synthetic explicit-VR little-endian 16-bit grayscale DICOM ──
function writeEl(bufs, group, elem, vr, value) {
  const tag = Buffer.alloc(4);
  tag.writeUInt16LE(group, 0);
  tag.writeUInt16LE(elem, 2);
  const vrB = Buffer.from(vr, 'ascii');
  if (vr === 'OW') {
    // Long form: tag(4) + VR(2) + reserved(2) + length(4) + value.
    const header = Buffer.alloc(8);
    vrB.copy(header, 0);
    header.writeUInt32LE(value.length, 4);
    bufs.push(tag, header, value);
  } else {
    // Short form: tag(4) + VR(2) + length(2) + value.
    const l = Buffer.alloc(2);
    l.writeUInt16LE(value.length, 0);
    bufs.push(tag, vrB, l, value);
  }
}

const W = 8, H = 6;
const pixels = Buffer.alloc(W * H * 2);
for (let i = 0; i < W * H; i++) {
  // Gradient 0..4095 unsigned
  pixels.writeUInt16LE(Math.floor((i * 4095) / (W * H - 1)), i * 2);
}

const preamble = Buffer.alloc(132);
preamble.write('DICM', 128, 'ascii');

const bufs = [preamble];
function us(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function str(s) { return Buffer.from(s, 'ascii'); }

writeEl(bufs, 0x0002, 0x0010, 'UI', str('1.2.840.10008.1.2.1\x00')); // Explicit LE uncompressed
writeEl(bufs, 0x0008, 0x0060, 'CS', str('US')); // modality, even length
writeEl(bufs, 0x0010, 0x0010, 'PN', str('TEST^PATIENT'));
writeEl(bufs, 0x0028, 0x0002, 'US', us(1));          // samples per pixel
writeEl(bufs, 0x0028, 0x0010, 'US', us(H));          // rows
writeEl(bufs, 0x0028, 0x0011, 'US', us(W));          // columns
writeEl(bufs, 0x0028, 0x0100, 'US', us(16));         // bits allocated
writeEl(bufs, 0x0028, 0x0103, 'US', us(0));          // unsigned
writeEl(bufs, 0x7fe0, 0x0010, 'OW', pixels);         // pixel data
const dicom = Buffer.concat(bufs);

// ── 1. Parser recognises it ──
const meta = DicomService.parse(dicom);
assert.ok(meta, 'parser returns metadata');
assert.strictEqual(meta.rows, H, 'rows parsed');
assert.strictEqual(meta.columns, W, 'columns parsed');
assert.strictEqual(meta.bitsAllocated, 16, 'bitsAllocated parsed');
assert.strictEqual(meta.pixelRepresentation, 0, 'pixelRepresentation parsed');
assert.ok(meta.pixelDataOffset > 0, 'pixel data located');
console.log('✅ Synthetic DICOM parsed:', { rows: meta.rows, cols: meta.columns, bits: meta.bitsAllocated });

// ── 2. Rasteriser produces a BMP data URI ──
const rendered = renderDicomToBmpDataUri(dicom);
assert.ok(rendered, 'rasteriser returns a result');
assert.ok(rendered.uri.startsWith('data:image/bmp;base64,'), 'output is a BMP data URI');

// BMP header sanity: total size, 8bpp, width/height.
const b64 = rendered.uri.slice('data:image/bmp;base64,'.length);
const bmp = Buffer.from(b64, 'base64');
assert.strictEqual(bmp.toString('ascii', 0, 2), 'BM', 'BMP magic');
assert.strictEqual(bmp.readUInt16LE(28), 8, '8 bpp');
assert.strictEqual(bmp.readInt32LE(18), W, 'BMP width');
assert.strictEqual(bmp.readInt32LE(22), H, 'BMP height');
const rowSize = Math.ceil(W / 4) * 4;
assert.strictEqual(bmp.readUInt32LE(34), rowSize * H, 'pixel bytes');
console.log('✅ BMP valid:', { width: bmp.readInt32LE(18), height: bmp.readInt32LE(22), bpp: bmp.readUInt16LE(28), size: bmp.length });

// Pixel data starts at the offset declared in the file header.
const dataOff = bmp.readUInt32LE(10);
// Brightest gradient sample = last source pixel (i = W*H-1), which lands in the
// bottom-up row 0, LAST column.
assert.strictEqual(bmp[dataOff + (W - 1)], 255, 'brightest pixel (gradient max) = 255');
// Darkest sample = first source pixel (i = 0) → top source row → output row H-1.
const lastOffset = dataOff + rowSize * (H - 1) + 0;
assert.strictEqual(bmp[lastOffset], 0, 'darkest pixel (gradient min) = 0');

// ── 3. Compressed transfer syntax is refused ──
const bufsJ = [preamble];
writeEl(bufsJ, 0x0002, 0x0010, 'UI', str('1.2.840.10008.1.2.4.50\x00')); // JPEG baseline
writeEl(bufsJ, 0x0028, 0x0002, 'US', us(1));
writeEl(bufsJ, 0x0028, 0x0010, 'US', us(H));
writeEl(bufsJ, 0x0028, 0x0011, 'US', us(W));
writeEl(bufsJ, 0x0028, 0x0100, 'US', us(8));
const jpegDicom = Buffer.concat(bufsJ);
assert.strictEqual(renderDicomToBmpDataUri(jpegDicom), null, 'compressed DICOM refused');
console.log('✅ Compressed transfer syntax correctly refused');

console.log('\n🎉 ALL DICOM-VIEWER TESTS PASSED');
