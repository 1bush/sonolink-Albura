/**
 * Test for DicomImage: builds synthetic DICOM files (8-bit, 16-bit multi-frame,
 * RGB planar/interleaved, RLE, and four rejection cases) and checks the decoder
 * and the PNG encoder.
 * Run: node scripts/dicom-image-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'DicomImage.js'))) {
  console.log('(compiling DicomImage to .tmp-test-build/...)');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/services/DicomImage.ts',
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
  decodeDicomToRgb,
  dicomFrameToPng,
  encodePng,
  RLE_TRANSFER_SYNTAX,
} = require(path.join(OUT, 'DicomImage.js'));

const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const LONG_VR = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'];

/** Builds an explicit-VR little-endian DICOM file around the given pixels. */
function buildDicom({ rows, columns, samples = 1, bits = 16, photometric, pixels, ts = EXPLICIT_LE, frames = 1 }) {
  const el = (g, e, vr, value) => {
    const tag = Buffer.alloc(4);
    tag.writeUInt16LE(g, 0);
    tag.writeUInt16LE(e, 2);
    const vrB = Buffer.from(vr, 'ascii');
    // PS3.5: every value is padded to an even length; text VRs pad with \0 (or
    // a space). The parser skips that padding, so a builder that omits it makes
    // the next element read from the wrong offset.
    const padded = value.length % 2 === 0 ? value : Buffer.concat([value, Buffer.from([0])]);
    // UL is a SHORT-form VR whose value is 4 bytes: tag(4) + VR(2) + length(2)
    // + value(4). The 2-byte length field happens to fit, so only the value
    // width is special.
    if (LONG_VR.includes(vr)) {
      const h = Buffer.alloc(8);
      vrB.copy(h, 0);
      h.writeUInt32LE(padded.length, 4);
      return Buffer.concat([tag, h, padded]);
    }
    const l = Buffer.alloc(2);
    l.writeUInt16LE(padded.length, 0);
    return Buffer.concat([tag, vrB, l, padded]);
  };
  /** (0002,0000) File Meta Information Group Length, VR 'UL', value 4 bytes. */
  const metaGroupLength = (byteLength) => {
    const tag = Buffer.alloc(4);
    tag.writeUInt16LE(0x0002, 0);
    tag.writeUInt16LE(0x0000, 2);
    const head = Buffer.alloc(4);
    head.write('UL', 0, 'ascii');
    head.writeUInt16LE(4, 2); // value length in bytes, NOT the meta length
    const val = Buffer.alloc(4);
    val.writeUInt32LE(byteLength, 0);
    return Buffer.concat([tag, head, val]);
  };
  const us = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
  };
  const str = (s) => Buffer.from(s, 'ascii');

  const body = [];
  const ds = [];
  ds.push(el(0x0008, 0x0016, 'UI', str('1.2.840.10008.5.1.4.1.1.4')), // SOP Class: US Image Storage
    el(0x0008, 0x0060, 'CS', str('US')), // Modality
    el(0x0020, 0x000d, 'UI', str('1.2.3.4.5')), // Study Instance UID
    el(0x0020, 0x000e, 'UI', str('1.2.3.4.5.1')), // Series Instance UID
    el(0x0020, 0x0013, 'IS', str('1')), // Instance Number
    el(0x0028, 0x0002, 'US', us(samples)),
    el(0x0028, 0x0004, 'CS', str(photometric || (samples === 3 ? 'RGB' : 'MONOCHROME2'))),
    el(0x0028, 0x0010, 'US', us(rows)),
    el(0x0028, 0x0011, 'US', us(columns)),
    el(0x0028, 0x0100, 'US', us(bits)),
    el(0x0028, 0x0101, 'US', us(bits)),
    el(0x0028, 0x0102, 'US', us(bits - 1)), // BitsStored
    el(0x0028, 0x0103, 'US', us(0)), // Pixel Representation: unsigned
    el(0x0028, 0x1050, 'DS', str('128')), // Window Center
    el(0x0028, 0x1051, 'DS', str('256'))); // Window Width
  if (frames > 1) ds.push(el(0x0028, 0x0008, 'IS', str(String(frames))));
  ds.push(el(0x7fe0, 0x0010, pixels.vr || 'OW', pixels.bytes));

  // PS3.10: a File Meta Information group is mandatory, and the parser needs
  // its (0002,0000) group length to find the Data Set that follows.
  // Transfer Syntax UID is (0002,0010); (0002,0002) is Media Storage SOP Class.
  const metaInner = Buffer.concat([
    el(0x0002, 0x0001, 'OB', Buffer.from([0x00, 0x01])),
    el(0x0002, 0x0010, 'UI', str(ts)),
  ]);
  const meta = Buffer.concat([metaGroupLength(metaInner.length), metaInner]);
  body.push(meta, ...ds);

  const head = Buffer.alloc(132);
  head.write('DICM', 128, 'ascii');
  return Buffer.concat([head, ...body]);
}

/* ── 1. 8-bit MONOCHROME2 ── */
{
  const W = 4, H = 2;
  const bytes = Buffer.from([0, 40, 80, 120, 160, 200, 240, 255]);
  const file = buildDicom({ rows: H, columns: W, bits: 8, pixels: { bytes } });
  const r = decodeDicomToRgb(file);
  assert.ok(r.ok, `expected decode to succeed, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.frames[0].width, W);
  assert.strictEqual(r.frames[0].height, H);
  assert.strictEqual(r.attributes.transferSyntax, EXPLICIT_LE);

  // Window 40/400 spans roughly -160..240, so the ramp rises but is compressed,
  // and the brightest stored value still lands on 255.
  const g = [];
  for (let i = 0; i < W * H; i++) g.push(r.frames[0].rgb[i * 3]);
  assert.ok(g[0] < g[7], `expected increasing luma, got ${g}`);
  assert.strictEqual(g[7], 255, 'brightest pixel must reach 255');
  assert.strictEqual(r.frames[0].rgb[1], g[0], 'grayscale must be replicated to R=G=B');
  console.log('✓ 8-bit MONOCHROME2 decodes; windowing applied, grey replicated');
}

/* ── 2. 16-bit over a multi-frame clip: one shared window ── */
{
  const W = 4, H = 2, FRAMES = 3;
  const bytes = Buffer.alloc(W * H * 2 * FRAMES);
  const levels = [10, 200, 200];
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < W * H; i++) bytes.writeUInt16LE(levels[f] + i, (f * W * H + i) * 2);
  }
  const file = buildDicom({ rows: H, columns: W, bits: 16, frames: FRAMES, pixels: { bytes } });
  const r = decodeDicomToRgb(file);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.frames.length, FRAMES, 'all three frames must decode');
  assert.strictEqual(r.attributes.numberOfFrames, FRAMES);

  // Frames 1 and 2 hold identical data, so they must render identically.
  assert.deepStrictEqual(
    Array.from(r.frames[1].rgb),
    Array.from(r.frames[2].rgb),
    'identical frames must render identically'
  );
  // The dark frame must NOT be stretched to full scale: a per-frame min/max would
  // blow its faint speckle up to 255 and make the cine flicker.
  const darkMax = Math.max(...Array.from({ length: W * H }, (_, i) => r.frames[0].rgb[i * 3]));
  assert.ok(darkMax < 128, `dark frame should stay dark under a shared window, got ${darkMax}`);
  console.log('✓ 16-bit multi-frame uses one shared window; frames do not pump');
}

/* ── 3. RGB colour, planar and interleaved ── */
{
  const W = 2, H = 2;
  // Row-major RGB triples: red, green / blue, white.
  const pixels = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  for (const planar of [0, 1]) {
    const bytes = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) {
        if (planar) bytes[c * W * H + i] = pixels[i][c];
        else bytes[i * 3 + c] = pixels[i][c];
      }
    }
    const file = buildDicom({
      rows: H,
      columns: W,
      samples: 3,
      bits: 8,
      photometric: 'RGB',
      pixels: { bytes, vr: 'OB' },
    });
    if (planar) {
      // buildDicom does not emit PlanarConfiguration, so inject the element.
      const el = Buffer.alloc(10);
      el.writeUInt16LE(0x0028, 0);
      el.writeUInt16LE(0x0006, 2);
      el.write('CS', 4, 'ascii');
      el.writeUInt16LE(2, 6);
      el.writeUInt16LE(1, 8);
      const at = file.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00]));
      const patched = Buffer.concat([file.subarray(0, at), el, file.subarray(at)]);
      const r = decodeDicomToRgb(patched);
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(r.attributes.planarConfiguration, 1, 'planar flag must be read');
      const rgb = r.frames[0].rgb;
      assert.deepStrictEqual(Array.from(rgb.subarray(0, 3)), [255, 0, 0], 'planar: red');
      assert.deepStrictEqual(Array.from(rgb.subarray(3, 6)), [0, 255, 0], 'planar: green');
      assert.deepStrictEqual(Array.from(rgb.subarray(9, 12)), [255, 255, 255], 'planar: white');
    } else {
      const r = decodeDicomToRgb(file);
      assert.ok(r.ok, JSON.stringify(r));
      const rgb = r.frames[0].rgb;
      assert.deepStrictEqual(Array.from(rgb.subarray(0, 3)), [255, 0, 0], 'interleaved: red');
      assert.deepStrictEqual(Array.from(rgb.subarray(3, 6)), [0, 255, 0], 'interleaved: green');
      assert.deepStrictEqual(
        Array.from(rgb.subarray(9, 12)),
        [255, 255, 255],
        'interleaved: white'
      );
    }
  }
  console.log('✓ RGB decodes in both planar and interleaved configuration');
}

/* ── 4. RLE-encoded single frame (the P50's actual transfer syntax) ── */
{
  const W = 8, H = 4;
  const raw = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) raw[i] = (i * 7) % 256;

  // PackBits: a literal run of 32 bytes is control byte 31 -> 32 literals.
  const payload = Buffer.concat([Buffer.from([31]), raw]);
  // PS3.5 Annex A.5: the RLE header is 15 uint32 segment counts followed by 15
  // uint32 offsets, i.e. 120 bytes. Offset table index N starts at byte 64.
  // A single-sample 8-bit image has only ONE non-empty plane, so only segment 1
  // is populated; segments 2-15 stay at zero count.
  const header = Buffer.alloc(120);
  header.writeUInt32LE(15, 0);
  header.writeUInt32LE(1, 4 + 4); // segment 1: one PackBits segment
  header.writeUInt32LE(header.length, 64 + 4); // its offset
  const frame = Buffer.concat([header, payload]);

  // Wrap the frame in an undefined-length Pixel Data element. buildDicom always
  // appends a native one, so take everything before it and substitute.
  const withNative = buildDicom({
    rows: H,
    columns: W,
    bits: 8,
    ts: RLE_TRANSFER_SYNTAX,
    pixels: { bytes: Buffer.alloc(W * H) },
  });
  const pxAt = withNative.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0x00]));
  assert.ok(pxAt > 0, 'native Pixel Data element not found');

  // An undefined-length item has NO length field: tag(4) + VR(2) + reserved(2),
  // which makes the 12-byte header the parser must skip.
  const tag = Buffer.alloc(12);
  tag.writeUInt16LE(0x7fe0, 0);
  tag.writeUInt16LE(0x0010, 2);
  tag.write('OB', 4, 'ascii');
  tag.writeUInt32LE(0xffffffff, 8);
  const end = Buffer.alloc(8);
  end.writeUInt16LE(0xfffe, 0);
  end.writeUInt16LE(0xe0dd, 2);

  // Encapsulated Pixel Data is a sequence of items, each with an 8-byte header
  // (tag FFFE,E000 + uint32 length). The FIRST item is the Basic Offset Table
  // and the rest carry the frame data.
  const item = (payload) => {
    const h = Buffer.alloc(8);
    h.writeUInt16LE(0xfffe, 0);
    h.writeUInt16LE(0xe000, 2);
    h.writeUInt32LE(payload.length, 4);
    return Buffer.concat([h, payload]);
  };
  const file = Buffer.concat([
    withNative.subarray(0, pxAt),
    tag,
    item(Buffer.alloc(0)), // empty Basic Offset Table
    item(frame),
    end,
  ]);

  const r = decodeDicomToRgb(file);
  assert.ok(r.ok, `RLE decode should succeed: ${JSON.stringify(r)}`);
  assert.strictEqual(r.attributes.encapsulated, true, 'undefined length must be detected');
  assert.strictEqual(r.attributes.transferSyntax, RLE_TRANSFER_SYNTAX);
  assert.strictEqual(r.frames.length, 1);
  // The window is 40/400, so check ordering rather than absolute values: the raw
  // ramp must survive the PackBits round trip in sequence.
  const g = Array.from({ length: W * H }, (_, i) => r.frames[0].rgb[i * 3]);
  const rising = g.every((v, i) => i === 0 || v >= g[i - 1]);
  assert.ok(rising, `RLE planes must decode in order, got ${g}`);
  assert.strictEqual(g[0], Math.min(...g), 'darkest raw value maps lowest');
  console.log('✓ RLE (PackBits) frame decodes — the P50 transfer syntax');
}

/* ── 5. Rejections: not DICOM, JPEG, deflated, truncated ── */
{
  const nr = decodeDicomToRgb(Buffer.from('this is not a dicom file at all'));
  assert.strictEqual(nr.ok, false);
  assert.strictEqual(nr.reason, 'unknown-syntax');

  const W = 4, H = 2;
  const pixels = { bytes: Buffer.alloc(W * H) };

  const jr = decodeDicomToRgb(
    buildDicom({ rows: H, columns: W, bits: 8, ts: '1.2.840.10008.1.2.4.50', pixels })
  );
  assert.strictEqual(jr.ok, false, 'JPEG Baseline must be refused, not silently mangled');
  assert.strictEqual(jr.reason, 'jpeg');

  const dr = decodeDicomToRgb(
    buildDicom({ rows: H, columns: W, bits: 8, ts: '1.2.840.10008.1.2.1.99', pixels })
  );
  assert.strictEqual(dr.ok, false);
  assert.strictEqual(dr.reason, 'deflated');

  // Claims 16 frames of pixel data but supplies only one.
  const sr = decodeDicomToRgb(
    buildDicom({ rows: H, columns: W, bits: 8, frames: 16, pixels })
  );
  assert.strictEqual(sr.ok, false, 'truncated pixel data must be reported');
  assert.match(sr.detail, /truncated/i);
  console.log('✓ non-DICOM, JPEG, deflated and truncated inputs are refused with a reason');
}

/* ── 6. PNG encoder produces a structurally valid file ── */
{
  const W = 5, H = 3;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) rgb[i] = (i * 11) % 256;
  // encodePng returns a plain Uint8Array (it runs on React Native too, where
  // Buffer does not exist), so wrap it to use Node's readUInt32BE helpers.
  const png = Buffer.from(encodePng(W, H, rgb));

  assert.deepStrictEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature'
  );
  assert.strictEqual(png.readUInt32BE(8), 13, 'IHDR length');
  assert.strictEqual(png.toString('ascii', 12, 16), 'IHDR');
  assert.strictEqual(png.readUInt32BE(16), W, 'IHDR width');
  assert.strictEqual(png.readUInt32BE(20), H, 'IHDR height');
  assert.strictEqual(png[24], 8, 'bit depth');
  assert.strictEqual(png[25], 2, 'colour type RGB');
  // The last chunk is length(4) + "IEND" + crc(4) = 12 bytes, so its declared
  // length is 0 at png.length-12 and the type string sits at png.length-8.
  assert.strictEqual(png.readUInt32BE(png.length - 12), 0, 'IEND data length 0');
  assert.strictEqual(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');

  // Every chunk must declare its own CRC correctly, or a real viewer rejects it.
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  let at = 8;
  const seen = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    // The CRC covers the type field followed by the chunk data.
    const declared = png.readUInt32BE(at + 8 + len);
    assert.strictEqual(
      crc32(png.subarray(at + 4, at + 8 + len)),
      declared,
      `${type} chunk CRC must be correct`
    );
    seen.push(type);
    at += 12 + len;
  }
  assert.strictEqual(at, png.length, 'chunk walk must land exactly on the end');
  assert.deepStrictEqual(seen, ['IHDR', 'IDAT', 'IEND'], 'exactly three chunks');

  // The IDAT must inflate to one filter byte + RGB per row, and back to the
  // exact pixels that went in.
  const idatAt = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const idatLen = png.readUInt32BE(idatAt - 4);
  const raw = zlib.inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLen));
  assert.strictEqual(raw.length, (W * 3 + 1) * H, 'inflated scanline size');
  for (let y = 0; y < H; y++) {
    assert.strictEqual(raw[y * (W * 3 + 1)], 0, `row ${y} filter byte is None`);
    assert.deepStrictEqual(
      Array.from(raw.subarray(y * (W * 3 + 1) + 1, (y + 1) * (W * 3 + 1))),
      Array.from(rgb.subarray(y * W * 3, (y + 1) * W * 3)),
      `row ${y} pixels round-trip exactly`
    );
  }
  console.log('✓ encodePng emits a valid PNG: chunks, filter bytes and pixels round-trip');
}

/* ── 7. dicomFrameToPng: the one-call path a phone screen uses ── */
{
  const W = 6, H = 4;
  const bytes = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) bytes[i] = i * 5;
  const file = buildDicom({ rows: H, columns: W, bits: 8, pixels: { bytes } });
  const png = Buffer.from(dicomFrameToPng(file, 0));
  assert.ok(png, 'expected a PNG for a decodable file');
  assert.deepStrictEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  assert.strictEqual(png.readUInt32BE(16), W, 'PNG width matches DICOM Columns');
  assert.strictEqual(png.readUInt32BE(20), H, 'PNG height matches DICOM Rows');

  assert.strictEqual(dicomFrameToPng(Buffer.from('nope')), null, 'garbage must return null');
  assert.strictEqual(dicomFrameToPng(file, 99), null, 'out-of-range frame must return null');
  console.log('✓ dicomFrameToPng converts frame 0 and returns null on failure');
}

console.log('\n🎉 ALL DICOM-IMAGE TESTS PASSED');




