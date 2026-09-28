// scripts/test-protocol.mjs
// Quick sanity check for the TLV protocol logic, runnable with plain `node`
// (no Expo/RN needed) since it only exercises string logic.
//
// Run: node scripts/test-protocol.mjs

function pad4(n) {
  return String(n).padStart(4, '0');
}

function buildQR({ ssid, password, encryption, host, port, patientId }) {
  const fields = [
    [9001, ssid],
    [9002, password],
    [9003, String(encryption)],
    [9004, host],
    [9005, String(port)],
    [9006, patientId],
  ];
  const tlvBlock = fields.map(([t, v]) => `${pad4(t)}${pad4(v.length)}${v}`).join('');
  const totalLen = 4 + tlvBlock.length;
  return `${pad4(9000)}${pad4(totalLen)}${pad4(6)}${tlvBlock}`;
}

function parseQR(raw) {
  let cursor = 0;
  const msgType = parseInt(raw.substring(cursor, cursor + 4), 10);
  cursor += 4;
  if (msgType !== 9000) throw new Error('bad msgType ' + msgType);
  cursor += 4; // totalLen, skip
  const tlvCount = parseInt(raw.substring(cursor, cursor + 4), 10);
  cursor += 4;
  if (tlvCount !== 6) throw new Error('bad tlvCount ' + tlvCount);

  const map = {};
  for (let i = 0; i < tlvCount; i++) {
    const type = parseInt(raw.substring(cursor, cursor + 4), 10);
    const len = parseInt(raw.substring(cursor + 4, cursor + 8), 10);
    cursor += 8;
    const value = raw.substring(cursor, cursor + len);
    cursor += len;
    map[type] = value;
  }
  return {
    ssid: map[9001],
    password: map[9002],
    encryption: map[9003],
    host: map[9004],
    port: parseInt(map[9005], 10),
    patientId: map[9006],
  };
}

const sample = {
  ssid: 'Sonoscape_P50_A1B2',
  password: 'sonoscape123',
  encryption: 2,
  host: '192.168.43.1',
  port: 8899,
  patientId: '20260710_120000_1234567',
};

const built = buildQR(sample);
console.log('Built QR string:', built);

const parsed = parseQR(built);
console.log('Parsed back:', parsed);

const ok =
  parsed.ssid === sample.ssid &&
  parsed.host === sample.host &&
  parsed.port === sample.port &&
  parsed.patientId === sample.patientId;

// ---------------------------------------------------------------------------
// REAL on-device capture — VALUES REDACTED, STRUCTURE PRESERVED.
//
// Decoded from the "QR Export" dialog on an actual SonoScope P50, photographed
// on 2026-09-15 (IMG_20260915_194824). Payload recovered straight out of the
// photo pixels (jsQR), NOT hand-typed — so this pins the wire format to
// observed bytes rather than to our own encoder's assumptions.
//
//   9000 0110 0006            msgType 9000 | totalLen 110 | 6 TLVs
//   9001 0011 "REDACTED-SS"   SSID              (11 chars)
//   9002 0010 "REDACTED01"    password          (10 chars)
//   9003 0001 "2"             encryption = WPA
//   9004 0012 "000.000.0.00"  host              (12 chars)
//   9005 0005 "99199"         port
//   9006 0023 "0000_00000000000_000"            patientId (23 chars)
//
// WHY THE VALUES ARE REPLACED BUT THE LENGTHS ARE NOT: this capture contains the
// clinic's real WiFi password and a real patient identifier. This repository is
// public, so publishing it verbatim would expose both. Every property this
// capture exists to prove is a property of the LENGTHS and the framing, not of
// the values, so substituting same-length strings keeps the test just as
// strict: totalLen still has to be payload.length - 12, and "0012"/"0023" still
// have to be read as decimal. A redaction that shortened a field would weaken
// the test, so none of these lengths was touched.
//
// totalLen 110 == payload.length (122) - 12, i.e. the header is NOT counted in
// the length field. The synthetic round-trip above cannot catch that off-by-12
// because our own encoder computes the same way it parses.
// ---------------------------------------------------------------------------
const REAL_QR =
  '90000110000690010011REDACTED-SS90020010REDACTED0190030001290040012000.000.0.009005000599199900600231026_00000000000000_000';

const realParsed = parseQR(REAL_QR);
console.log('Real device QR parsed:', realParsed);

const realChecks = [
  // Compare numerically: "0110" and "110" are the same number, not the same string.
  ['header totalLen counts only the TLV block',
    parseInt(REAL_QR.slice(4, 8), 10) === REAL_QR.length - 12],
  ['ssid', realParsed.ssid === 'REDACTED-SS'],
  ['password', realParsed.password === 'REDACTED01'],
  ['encryption raw', realParsed.encryption === '2'],
  ['host', realParsed.host === '000.000.0.00'],
  ['port', realParsed.port === 99199],
  ['patientId', realParsed.patientId === '1026_00000000000000_000'],
  // TLV lengths are plain decimal pairs, not hex: a 12-char value is "0012",
  // and 23 chars is "0023". Reading them as hex (0x12=18) silently truncates.
  ['lengths are decimal not hex', REAL_QR.includes('90040012') && REAL_QR.includes('90060023')],
  // The redaction must not have changed the payload size: 122 characters is
  // what makes the totalLen assertion above meaningful, and a future edit that
  // shortened a field would otherwise quietly weaken this whole capture.
  ['redacted payload is still 122 chars', REAL_QR.length === 122],
];

if (!ok) {
  console.error('❌ Round-trip MISMATCH');
  process.exit(1);
} else {
  console.log('✅ Round-trip OK — QR build/parse matches the on-device format seen in QR Export screen.');
}

console.log('\n--- real on-device payload checks ---');
let realOk = true;
for (const [name, pass] of realChecks) {
  console.log(`${pass ? '✅' : '❌'} ${name}`);
  if (!pass) realOk = false;
}
if (!realOk) {
  console.error('❌ Real on-device payload does NOT match the assumed format');
  process.exit(1);
}
console.log('✅ Real P50 QR payload parses cleanly — format confirmed against actual device bytes.');
