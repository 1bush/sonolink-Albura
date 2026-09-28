/**
 * Test for sonodropCrypto: checks that encrypted transfers are recognised and
 * that real files are never mistaken for ciphertext.
 * Run: node scripts/crypto-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'sonodropCrypto.js'))) {
  console.log('(compiling sonodropCrypto to .tmp-test-build/...)');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/services/sonodropCrypto.ts',
      '--outDir',
      OUT,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--esModuleInterop',
      '--skipLibCheck',
      '--moduleResolution',
      'node',
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
}

const {
  detectEncryptedTransfer,
  markEncryptedName,
  keyFingerprint,
  SONODROP_STATIC_KEY,
  ENC_SUFFIX,
} = require(path.join(OUT, 'sonodropCrypto.js'));

/** Signatures for the formats fileKinds knows, so the tests use real bytes. */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(32)]);
const bmp = () => { const b = Buffer.alloc(54); b.write('BM', 0, 'ascii'); b.writeUInt32LE(54, 2); return b; };
const pdf = () => Buffer.from('%PDF-1.7\ntrailer', 'binary');
const mp4 = () => { const b = Buffer.alloc(64); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'ascii'); return b; };
const avi = () => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'ascii'); b.write('AVI LIST', 8, 'ascii'); return b; };
const dicom = () => { const b = Buffer.alloc(200); b.write('DICM', 128, 'ascii'); return b; };

/** Opaque bytes: no signature at any offset, which is what ciphertext looks like. */
const ciphertext = () => {
  const b = Buffer.alloc(256);
  for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) % 256;
  // Make sure no accidental signature slipped in.
  b[0] = 0x5a; b[1] = 0x33;
  return b;
};

/* ── 1. A .enc file with no signature IS ciphertext ── */
{
  const v = detectEncryptedTransfer('IMG_0001.JPG' + ENC_SUFFIX, ciphertext());
  assert.strictEqual(v.encrypted, true, 'named .enc with opaque bytes must be called encrypted');
  assert.match(v.reason, /WiFi password/, 'the reason must name the key source');
  console.log('✓ a .enc payload with no signature is detected as encrypted');
}

/* ── 2. A real file never gets called encrypted, whatever its name ── */
{
  // The dangerous direction is flagging a real image as ciphertext, because the
  // user would be told a perfectly good scan is unreadable.
  const cases = [
    ['IMG.JPG' + ENC_SUFFIX, jpeg()],
    ['weird.png' + ENC_SUFFIX, png()],
    ['x.bmp' + ENC_SUFFIX, bmp()],
    ['report.pdf' + ENC_SUFFIX, pdf()],
    ['cine.mp4' + ENC_SUFFIX, mp4()],
    ['cine.avi' + ENC_SUFFIX, avi()],
    ['study.dcm' + ENC_SUFFIX, dicom()],
  ];
  for (const [name, bytes] of cases) {
    const v = detectEncryptedTransfer(name, bytes);
    assert.strictEqual(v.encrypted, false, `${name} has a real signature and must not be flagged`);
  }
  console.log('✓ all 7 real formats stay unencrypted even when named .enc');
}

/* ── 3. Both signals are required ── */
{
  // .enc suffix alone with a real signature: not encrypted.
  assert.strictEqual(detectEncryptedTransfer('a.jpg' + ENC_SUFFIX, jpeg()).encrypted, false);
  // No suffix, opaque bytes: also not called encrypted, because a truncated
  // transfer looks identical and the fileKinds "unknown" path handles it.
  assert.strictEqual(detectEncryptedTransfer('partial.jpg', ciphertext()).encrypted, false);
  assert.match(detectEncryptedTransfer('partial.jpg', ciphertext()).reason, /Not an encrypted/);
  console.log('✓ neither signal alone is enough; both are required');
}

/* ── 4. markEncryptedName is idempotent and never lies ── */
{
  assert.strictEqual(markEncryptedName('IMG_1.jpg'), 'IMG_1.jpg' + ENC_SUFFIX);
  assert.strictEqual(markEncryptedName('IMG_1.jpg' + ENC_SUFFIX), 'IMG_1.jpg' + ENC_SUFFIX);
  assert.strictEqual(markEncryptedName('IMG_1.jpg.ENC'), 'IMG_1.jpg.ENC', 'uppercase already ends with it');
  console.log('✓ markEncryptedName adds the suffix once and leaves it alone the second time');
}

/* ── 5. keyFingerprint separates keys without revealing them ── */
{
  const a = keyFingerprint('al0u5a2b2r');
  const b = keyFingerprint('al0u5a2b2r');
  const c = keyFingerprint('different1');
  assert.strictEqual(a, b, 'the same key must fingerprint identically');
  assert.notStrictEqual(a, c, 'different keys must not collide here');
  assert.match(a, /^[0-9a-f]{8}$/, 'must be a fixed-width hex string');
  // The fingerprint must not contain the key in any form.
  assert.ok(!a.includes('al0u'), 'the fingerprint must not embed the key');
  console.log('✓ keyFingerprint is stable, distinguishing, and leaks nothing');
}

/* ── 6. The static key matches what the binary actually contains ── */
{
  // Recorded so a future change to the .so is caught: this literal sits in
  // .rodata next to the ".enc" and fopen strings in libklnetio.so.
  assert.strictEqual(SONODROP_STATIC_KEY, '19040435');
  assert.strictEqual(SONODROP_STATIC_KEY.length, 8, 'an 8-character key');
  assert.strictEqual(ENC_SUFFIX, '.enc');
  console.log('✓ the recovered static key and .enc suffix are pinned');
}

console.log('\n🎉 ALL CRYPTO TESTS PASSED');

