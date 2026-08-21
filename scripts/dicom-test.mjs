// DICOM parser round-trip test — compile DicomService.ts on the fly (no
// extra runtime deps), build a minimal Explicit-VR little-endian DICOM
// buffer by hand, and confirm DicomService.parse reads it back.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTs(relPath) {
  const abs = join(__dirname, relPath);
  const src = readFileSync(abs, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = { exports: {} };
  // Expose a minimal `require` for 'buffer' (node builtin) and 'buffer/*'
  const localRequire = (id) => require(id);
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', js)(localRequire, m, m.exports);
  return m.exports;
}

const { DicomService } = loadTs('../src/services/DicomService.ts');

function buildDicom() {
  const bytes = [];
  // 128-byte zero preamble
  for (let i = 0; i < 128; i++) bytes.push(0);
  // "DICM" magic
  for (const c of 'DICM') bytes.push(c.charCodeAt(0));

  function pushShort(tag, vr, valueBytes) {
    bytes.push(tag & 0xff, (tag >> 8) & 0xff, (tag >> 16) & 0xff, (tag >> 24) & 0xff);
    for (const c of vr) bytes.push(c.charCodeAt(0));
    bytes.push(valueBytes.length & 0xff, (valueBytes.length >> 8) & 0xff);
    for (const v of valueBytes) bytes.push(v);
    if (valueBytes.length % 2 === 1) bytes.push(0);
  }

  pushShort(0x00100010, 'PN', [...new TextEncoder().encode('JOE^DOE')]);
  pushShort(0x00100020, 'LO', [...new TextEncoder().encode('US-123')]);
  pushShort(0x00080060, 'CS', [...new TextEncoder().encode('US')]);
  pushShort(0x00280010, 'US', [480 & 0xff, (480 >> 8) & 0xff]);
  return new Uint8Array(bytes);
}

const exit = (msg) => { console.error('FAIL — ' + msg); process.exit(1); };

const meta = DicomService.parse(buildDicom());
if (!meta) exit('parse returned null');
console.log('Parsed DICOM:', JSON.stringify(meta));
if (meta.patientName !== 'JOE^DOE') exit('patientName mismatch: ' + meta.patientName);
if (meta.patientId !== 'US-123') exit('patientId mismatch: ' + meta.patientId);
if (meta.modality !== 'US') exit('modality mismatch: ' + meta.modality);
if (meta.rows !== 480) exit('rows mismatch: ' + meta.rows);
console.log('✓ DICOM round-trip OK');

// Non-DICOM buffer must return null (defensive path).
const junk = new Uint8Array([1, 2, 3, 4, 5]);
if (DicomService.parse(junk) !== null) exit('non-DICOM should return null');
console.log('✓ non-DICOM rejected OK');