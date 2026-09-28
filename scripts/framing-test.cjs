/**
 * Test for framing: builds SonoDrop messages in the exact shape recovered from
 * the decompiled APK and checks the reader reassembles them byte-for-byte.
 * Run: node scripts/framing-test.cjs
 *
 * The builders below mirror DataTransferThread.smali:
 *   msgType   = 4 ASCII digits at offset 0
 *   length    = 4 ASCII digits at offset 4
 *   TLV block = starts at offset 12, each field [type:4][len:4][value:len]
 *   the whole header is exactly 256 bytes
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'framing.js'))) {
  console.log('(compiling framing to .tmp-test-build/...)');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/services/framing.ts',
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
  FileFrameReader,
  parseTlvBlock,
  buildStudyId,
  HEADER_BYTES,
  MSG_FILE_HEAD,
  MSG_CTRL,
} = require(path.join(OUT, 'framing.js'));

/** [type:4][len:4][value] — every numeric field is decimal ASCII. */
function tlv(type, value) {
  const t = String(type).padStart(4, '0');
  const v = String(value);
  return t + String(v.length).padStart(4, '0') + v;
}

/** Builds the 256-byte FileHead the device writes, then the payload. */
function fileHeadMessage({ dept, time, name, size, total, index }, payload) {
  const head = Buffer.alloc(HEADER_BYTES, 0x20); // space-filled, like the device's buffer
  head.write(MSG_FILE_HEAD, 0, 'ascii');
  head.write(String(256 + payload.length).padStart(4, '0'), 4, 'ascii');
  const block = tlv(8001, dept) + tlv(8002, time) + tlv(8003, name) + tlv(8004, size) +
    tlv(8005, total) + tlv(8006, index);
  head.write(block, 12, 'ascii');
  return Buffer.concat([head, payload]);
}

/** A control message: msgType 5000, its own length, no file payload. */
function ctrlMessage(body = '') {
  const head = Buffer.alloc(HEADER_BYTES, 0x20);
  head.write(MSG_CTRL, 0, 'ascii');
  head.write(String(body.length).padStart(4, '0'), 4, 'ascii');
  head.write(body, 8, 'ascii');
  return head;
}

/* ── 1. A single file frame round-trips byte-for-byte ── */
{
  const payload = Buffer.alloc(3000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
  const msg = fileHeadMessage(
    { dept: 'GYN', time: '2026:09:14:10:30', name: 'IMG_0001.JPG', size: payload.length, total: '5', index: '1' },
    payload
  );

  const reader = new FileFrameReader();
  const frames = reader.push(msg);
  assert.strictEqual(frames.length, 1, 'exactly one frame must come out');
  const f = frames[0];
  assert.strictEqual(f.kind, MSG_FILE_HEAD);
  assert.strictEqual(f.name, 'IMG_0001.JPG');
  assert.strictEqual(f.bytes.length, 3000);
  assert.ok(f.bytes.equals(payload), 'payload must be byte-identical');
  // Routing fields come from positions 0,1,4,5 of the TLV block.
  assert.strictEqual(f.dept, 'GYN');
  assert.strictEqual(f.time, '2026:09:14:10:30');
  assert.strictEqual(f.total, '5');
  assert.strictEqual(f.index, '1');
  console.log('✓ a 3000 B file frame is reassembled byte-for-byte, fields in order');
}

/* ── 2. The message arrives split across chunks ── */
{
  const payload = Buffer.from('abcdefghij'.repeat(400));
  const whole = fileHeadMessage(
    { dept: 'OBG', time: '2026:09:14:11:00', name: 'CINE_01.avi', size: payload.length, total: '1', index: '1' },
    payload
  );

  // Split at awkward points: mid-header, mid-filename, mid-payload.
  const reader = new FileFrameReader();
  let got = [];
  let rest = whole;
  for (const cut of [7, 93, 163, 256, 300, 1000, 2560, 3560]) {
    if (rest.length === 0) break;
    const take = Math.min(cut, rest.length);
    got = got.concat(reader.push(rest.subarray(0, take)));
    rest = rest.subarray(take);
  }
  if (rest.length) got = got.concat(reader.push(rest));
  assert.strictEqual(got.length, 1, 'the split must not lose or duplicate the frame');
  assert.ok(got[0].bytes.equals(payload), 'payload must survive arbitrary chunking');
  assert.strictEqual(got[0].name, 'CINE_01.avi');
  console.log('✓ a message split into 8 chunks at arbitrary offsets still reassembles');
}

/* ── 3. A control message is skipped, not mistaken for file data ── */
{
  const reader = new FileFrameReader();
  assert.deepStrictEqual(reader.push(ctrlMessage('heartbeat')), [], 'control yields no frame');

  const payload = Buffer.from('real file bytes here');
  const frames = reader.push(
    fileHeadMessage(
      { dept: 'CARD', time: '2026:09:14:12:00', name: 'RPT.PDF', size: payload.length, total: '1', index: '1' },
      payload
    )
  );
  assert.strictEqual(frames.length, 1, 'the file after a control message must still arrive');
  assert.ok(frames[0].bytes.equals(payload));
  console.log('✓ a 5000 control message is skipped and the next file still decodes');
}

/* ── 4. Several files in one chunk ── */
{
  const names = ['IMG_1.JPG', 'IMG_2.JPG', 'IMG_3.JPG'];
  const payloads = names.map((_, i) => Buffer.from(`${i}`.repeat(50 + i)));
  const msgs = payloads.map((p, i) =>
    fileHeadMessage(
      { dept: 'GYN', time: '2026:09:14:10:30', name: names[i], size: p.length, total: '3', index: String(i + 1) },
      p
    )
  );
  const frames = new FileFrameReader().push(Buffer.concat(msgs));
  assert.strictEqual(frames.length, 3, 'all three files must come out of one chunk');
  assert.deepStrictEqual(frames.map((f) => f.name), names, 'in order');
  frames.forEach((f, i) => assert.ok(f.bytes.equals(payloads[i]), `${names[i]} payload`));
  console.log('✓ three files bundled into one TCP chunk all decode, in order');
}

/* ── 5. Garbage cannot wedge the stream ── */
{
  // A 400-byte junk burst before a real message must not produce a phantom
  // frame, and must not stop the real frame from being read afterwards.
  const junk = Buffer.alloc(400);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 7) % 256;
  const payload = Buffer.from('after the garbage');
  const real = fileHeadMessage(
    { dept: 'GYN', time: '2026:09:14:13:00', name: 'OK.JPG', size: payload.length, total: '1', index: '1' },
    payload
  );

  const reader = new FileFrameReader();
  const frames = reader.push(Buffer.concat([junk, real]));
  const ok = frames.filter((f) => f.name === 'OK.JPG');
  assert.strictEqual(ok.length, 1, 'the real frame must survive a junk prefix');
  assert.ok(ok[0].bytes.equals(payload));
  console.log('✓ 400 B of junk is resynchronised past, the following frame still decodes');
}

/* ── 6. An incomplete frame is held, not returned short ── */
{
  const payload = Buffer.alloc(500, 0xab);
  const msg = fileHeadMessage(
    { dept: 'GYN', time: '2026:09:14:14:00', name: 'BIG.BMP', size: payload.length, total: '1', index: '1' },
    payload
  );
  const reader = new FileFrameReader();
  // Header plus only half the payload: nothing may be emitted yet.
  const partial = msg.subarray(0, HEADER_BYTES + 250);
  assert.deepStrictEqual(reader.push(partial), [], 'a half-received file must yield nothing');
  // The rest arrives and the whole file appears exactly once.
  const frames = reader.push(msg.subarray(HEADER_BYTES + 250));
  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].bytes.equals(payload), 'the file must be complete, not truncated');
  console.log('✓ a half-received file is held until complete, then emitted whole');
}

/* ── 7. parseTlvBlock stops at the space padding ── */
{
  // The device's 256-byte buffer is space/NUL filled after the TLV block, so
  // the parser must stop on the first non-numeric field rather than run on.
  const block = tlv(8001, 'GYN') + tlv(8003, 'A.JPG');
  const padded = block + ' '.repeat(40);
  const { fields } = parseTlvBlock(padded, 0);
  assert.strictEqual(fields.length, 2, 'parsing must stop at the padding');
  assert.deepStrictEqual(fields[0], { type: '8001', value: 'GYN' });
  assert.deepStrictEqual(fields[1], { type: '8003', value: 'A.JPG' });
  console.log('✓ TLV parsing stops at the buffer padding instead of running on');
}

/* ── 8. buildStudyId matches the device's own formula ── */
{
  // createStudyDir: mTime.replace(":", "-") + "_" + mDept
  assert.strictEqual(buildStudyId('2026:09:14:10:30', 'GYN'), '2026-09-14-10-30_GYN');
  assert.strictEqual(buildStudyId('2026:09:14:10:30', 'USALB'), '2026-09-14-10-30_USALB');
  assert.strictEqual(buildStudyId('10:30', 'CV'), '10-30_CV');
  console.log('✓ the study id is built exactly as createStudyDir does');
}

console.log('\n🎉 ALL FRAMING TESTS PASSED');


