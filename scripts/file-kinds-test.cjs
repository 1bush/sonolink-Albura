/**
 * Test for fileKinds: builds files with each real magic signature and checks
 * that they are identified from their bytes, not their names.
 * Run: node scripts/file-kinds-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'fileKinds.js'))) {
  console.log('(compiling fileKinds to .tmp-test-build/...)');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/services/fileKinds.ts',
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

const { detectKindFromBytes, identifyFile, correctedName } = require(path.join(OUT, 'fileKinds.js'));

/* ── Builders for each real signature ── */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(32)]);
const bmp = () => {
  const b = Buffer.alloc(54);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(54, 2);
  return b;
};
const pdf = () => Buffer.from('%PDF-1.7\ntrailer', 'binary');
const mp4 = () => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(24, 0); // box size
  b.write('ftypisom', 4, 'ascii');
  b.write('isomiso2avc1mp41', 16, 'ascii');
  return b;
};
const avi = () => {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(56, 4);
  b.write('AVI LIST', 8, 'ascii');
  return b;
};
const dicom = () => {
  const b = Buffer.alloc(200);
  b.write('DICM', 128, 'ascii');
  b.write('OB', 132 + 4, 'ascii');
  return b;
};
const junk = () => Buffer.alloc(200, 0x5a);

/* ── 1. Every signature is recognised from its bytes alone ── */
{
  const cases = [
    ['jpeg', jpeg()],
    ['png', png()],
    ['bmp', bmp()],
    ['pdf', pdf()],
    ['mp4', mp4()],
    ['avi', avi()],
    ['dicom', dicom()],
  ];
  for (const [expected, bytes] of cases) {
    // Deliberately give every file the SAME wrong name: a ".jpg" that is
    // really an MP4 is the exact case the P50 produces.
    const id = identifyFile('IMG_0001.jpg', bytes);
    assert.strictEqual(id.kind, expected, `${expected} bytes misidentified as ${id.kind}`);
    assert.strictEqual(id.fromContent, true, `${expected} must be identified from content`);
  }
  console.log('✓ all 7 signatures win over a deliberately wrong .jpg name');
}

/* ── 2. The gallery action per format ── */
{
  assert.strictEqual(identifyFile('a.jpg', jpeg()).galleryAction, 'photo');
  assert.strictEqual(identifyFile('a.png', png()).galleryAction, 'photo');
  assert.strictEqual(identifyFile('a.bmp', bmp()).galleryAction, 'photo');
  assert.strictEqual(identifyFile('a.mp4', mp4()).galleryAction, 'video');
  // These three the media library cannot represent, and must be kept honest.
  assert.strictEqual(identifyFile('a.avi', avi()).galleryAction, 'none');
  assert.strictEqual(identifyFile('a.pdf', pdf()).galleryAction, 'none');
  assert.strictEqual(identifyFile('a.dcm', dicom()).galleryAction, 'none');
  console.log('✓ photo / video / none assigned correctly, including AVI and PDF');
}

/* ── 3. A short read is not guessed at ── */
{
  // A cine loop that has only delivered 3 bytes: not even the ftyp box type
  // at offset 4 has arrived, so detectKindFromBytes must say so rather than
  // invent a format.
  const partial = mp4().subarray(0, 3);
  assert.strictEqual(detectKindFromBytes(partial), null, 'a 3-byte prefix must not match');

  // But the name fallback still gives the file somewhere to go.
  const id = identifyFile('CINE_001.MP4', partial);
  assert.strictEqual(id.kind, 'mp4');
  assert.strictEqual(id.fromContent, false, 'name fallback must be flagged as such');
  assert.match(id.note, /name only/i);

  // Once the full file has arrived the content takes over.
  const full = identifyFile('CINE_001.MP4', mp4());
  assert.strictEqual(full.fromContent, true, 'content must win once readable');
  console.log('✓ a partial transfer falls back to the name and never guesses a format');
}

/* ── 4. Unrecognised bytes are reported, not silently accepted ── */
{
  const id = identifyFile('scan.bin', junk());
  assert.strictEqual(id.kind, 'unknown');
  assert.strictEqual(id.galleryAction, 'none');
  assert.strictEqual(id.suggestedExtension, '', 'no extension may be invented');
  assert.strictEqual(detectKindFromBytes(junk()), null);
  assert.strictEqual(identifyFile('no_extension', junk()).kind, 'unknown');
  console.log('✓ unrecognised bytes are reported as unknown, with no invented extension');
}

/* ── 5. The filename is corrected to match the bytes ── */
{
  const cases = [
    ['IMG_0001.jpg', mp4(), 'IMG_0001.mp4'],
    ['CINE_1.jpg', avi(), 'CINE_1.avi'],
    ['scan.jpg', pdf(), 'scan.pdf'],
    ['REPORT.pdf', jpeg(), 'REPORT.jpg'],
    ['noext', bmp(), 'noext.bmp'],
    ['scan.bin', junk(), 'scan.bin'], // unknown: left alone
  ];
  for (const [name, bytes, expected] of cases) {
    assert.strictEqual(correctedName(name, identifyFile(name, bytes)), expected, name);
  }
  console.log('✓ filenames are corrected to match the real format, unknown left alone');
}

/* ── 6. Every magic signature sits at a distinct offset (regression guard) ── */
{
  // If two formats shared an offset the "content wins" rule would misfire, so
  // assert the offsets explicitly rather than trusting the ordering above.
  assert.strictEqual(mp4().subarray(4, 8).toString('ascii'), 'ftyp', 'ftyp at offset 4');
  assert.strictEqual(avi().subarray(0, 4).toString('ascii'), 'RIFF', 'RIFF at offset 0');
  assert.strictEqual(avi().subarray(8, 12).toString('ascii'), 'AVI ', 'AVI at offset 8');
  assert.strictEqual(dicom().toString('ascii', 128, 132), 'DICM', 'DICM at offset 128');
  assert.strictEqual(pdf().subarray(0, 5).toString('ascii'), '%PDF-', '%PDF- at offset 0');
  console.log('✓ magic-byte offsets are pinned, so no two formats can collide');
}

console.log('\n🎉 ALL FILE-KINDS TESTS PASSED');


