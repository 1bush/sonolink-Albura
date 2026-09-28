/**
 * Test for the optical bridge: simulates the Drita LightScan path.
 *
 * What it proves (and what no existing test covered):
 *   A real file is encoded with LTEncoder, each frame is wrapped in the SAME
 *   "D1C3:" base64 envelope that decodeOpticalQrData expects from a QR scan,
 *   fed through ingestOpticalFrame in arbitrary order, and the bytes are
 *   compared to the original. This is the exact call chain DritaExtrasScreen
 *   now uses via drainAndDecodeOpticalFrames.
 *
 * Also covers the frames-on-screen edge cases: duplicates, and a non-Decimen
 * QR (e.g. the P50 pairing QR) that must be rejected rather than mis-parsed.
 *
 * Run: node scripts/optical-bridge-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build-bridge');

if (!fs.existsSync(path.join(OUT, 'OpticalTransferService.js'))) {
  console.log('(compiling optical protocol to .tmp-test-build-bridge/...)');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/services/opticalProtocol.ts',
    'src/services/OpticalTransferService.ts',
    '--outDir', OUT,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--skipLibCheck',
    '--moduleResolution', 'node',
  ], { cwd: ROOT, stdio: 'inherit' });
}

const {
  packFile, LTEncoder, fnv1a,
} = require(path.join(OUT, 'opticalProtocol.js'));
const {
  encodeOpticalQrData, decodeOpticalQrData, ingestOpticalFrame,
} = require(path.join(OUT, 'OpticalTransferService.js'));

// ── 1. A real file, encoded exactly as a Decimen sender would ──
// NOTE: packFile is async (it may gzip when a compressor is supplied), so the
// whole test body runs inside main().
async function main() {
const payload = Buffer.alloc(3000);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
const { container, originalSize } = await packFile('sono-test.dcm', 'application/dicom', payload);
const checksum = fnv1a(container);

const encoder = new LTEncoder(container, 64, 0x4242);
const k = encoder.k;
const totalLen = container.length;
console.log(`✅ Encoder: k=${k} blockLen=64 containerLen=${totalLen} (orig ${originalSize} B)`);

// ── 2. Every frame as scanned QR TEXT (D1C3: base64) ──
function frameAsQrText(seq) {
  const block = encoder.encode(seq);
  const bytes = new Uint8Array(22 + block.length);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0xd1; bytes[1] = 0xc3; bytes[2] = 3; bytes[3] = 0;
  dv.setUint16(4, 0x4242, true);
  dv.setUint32(6, seq, true);
  dv.setUint16(10, k, true);
  dv.setUint16(12, 64, true);
  dv.setUint32(14, totalLen, true);
  dv.setUint32(18, checksum >>> 0, true);
  bytes.set(block, 22);
  // The scanner returns TEXT; encodeOpticalQrData is the sender's envelope.
  return encodeOpticalQrData(bytes);
}

// ── 3. A non-Decimen QR (the P50 pairing QR) must be rejected, not misread ──
const p50Qr = '90000122000690010018Sonoscape_P50_A1B290020012sonoscape12390030001';
assert.strictEqual(decodeOpticalQrData(p50Qr), null, 'P50 pairing QR is not a Decimen frame');
console.log('✅ P50 pairing QR correctly rejected (not a Decimen frame)');

// A QR the scanner truncates or mangles must also be rejected.
assert.strictEqual(decodeOpticalQrData('D1C3:!!!not-base64!!!'), null, 'garbage rejected');
console.log('✅ Malformed envelope correctly rejected');

// ── 4. Feed the stream: out of order, with duplicates — as a real scan does ──
const state = { decoder: null, identity: null };
let completed = null;
const progressLog = [];

const opts = {
  transferId: 'test',
  onFrame: () => {},
  onError: (e) => { throw new Error(`unexpected decode error: ${e}`); },
  onProgress: (p, t) => progressLog.push([p, t]),
  onComplete: (r) => { completed = r; },
};

const order = [];
for (let i = 0; i < k; i++) order.push(i);
order.push(0, 1); // duplicates — a carousel re-sends, must not corrupt
// Shuffle deterministically (no Math.random, so failures reproduce).
for (let i = order.length - 1; i > 0; i--) {
  const j = (i * 7) % (i + 1);
  [order[i], order[j]] = [order[j], order[i]];
}

let accepted = 0;
for (const seq of order) {
  const text = frameAsQrText(seq);
  // Round-trip through the scanner's text representation.
  const bytes = decodeOpticalQrData(text);
  assert.ok(bytes, `frame ${seq} survives QR text round-trip`);
  assert.strictEqual(bytes.length, 22 + 64, `frame ${seq} has expected length`);

  const r = ingestOpticalFrame(state, bytes, opts);
  if (r) accepted++;
  if (completed) break; // stop early once complete
}
console.log(`✅ Fed ${accepted} frames (out of order, with duplicates) — no decode errors`);
assert.ok(progressLog.length > 0, 'progress callbacks fired');
assert.ok(progressLog.some(([p]) => p > 0), 'progress advanced past zero');
console.log('✅ Progress callbacks reported:', progressLog.length, 'updates');

// ── 5. The reassembled file must be byte-identical ──
assert.ok(completed, 'transfer completed');
assert.ok(completed.success, 'transfer reported success');
assert.strictEqual(completed.fileName, 'sono-test.dcm', 'filename survived the container');
assert.strictEqual(completed.fileSize, payload.length, 'payload length matches original');
assert.deepStrictEqual(
  Buffer.from(completed.fileBytes),
  payload,
  'reassembled bytes are IDENTICAL to the original file',
);
console.log('✅ File reconstructed byte-for-byte:', completed.fileName,
  `(${completed.fileBytes.length} B, checksum ${completed.checksum})`);

// ── 6. Decoder must reset after success so the next stream starts clean ──
assert.strictEqual(state.decoder, null, 'decoder cleared after completion');
assert.strictEqual(state.identity, null, 'identity cleared after completion');
console.log('✅ Decoder state reset — ready for the next transfer');

console.log('\n🎉 ALL OPTICAL-BRIDGE TESTS PASSED');
}

main().catch((err) => {
  console.error('\n❌ OPTICAL-BRIDGE TEST FAILED:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});

