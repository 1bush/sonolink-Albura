/**
 * Functional test for the improved ingestOpticalFrame error-recovery logic.
 * Self-contained: compiles the protocol TS to a temp dir on first run.
 * Run: node scripts/ingest-recovery-test.cjs
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-test-build');

if (!fs.existsSync(path.join(OUT, 'services', 'opticalProtocol.js'))) {
  console.log('(compiling protocol TS to .tmp-test-build/...)');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/services/opticalProtocol.ts',
    'src/services/OpticalTransferService.ts',
    'src/protocol/sonoDropProtocol.ts',
    '--outDir', OUT,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--esModuleInterop',
    '--skipLibCheck',
    '--moduleResolution', 'node',
  ], { cwd: ROOT, stdio: 'inherit' });
}

const {
  packFile, packFrame, LTEncoder, fnv1a, WIRE_VERSION,
} = require(path.join(OUT, 'services', 'opticalProtocol.js'));
const { ingestOpticalFrame } = require(path.join(OUT, 'services', 'OpticalTransferService.js'));

async function main() {
  const payload = new Uint8Array(2000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 11 + 3) & 0xff;

  const packed = await packFile('IMG_0001.jpg', 'image/jpeg', payload);
  const container = packed.container;
  const realChecksum = fnv1a(container);
  const blockLen = 64;
  const sessionId = 4242;
  const enc = new LTEncoder(container, blockLen, sessionId);

  // ── Scenario 1: clean transfer + onProgress + duration ──
  {
    const state = { decoder: null, identity: null, startTime: undefined };
    let progressCalls = 0;
    let completed = null;
    let errored = [];
    const frames = [];
    for (let seq = 0; seq < enc.k + 10; seq++) {
      frames.push(packFrame({
        sessionId, seq, k: enc.k, blockLen, totalLen: container.length,
        payloadFnv: realChecksum, flags: 0,
      }, enc.encode(seq)));
    }
    for (const f of frames) {
      ingestOpticalFrame(state, f, {
        transferId: 't1',
        onFrame: () => {},
        onComplete: (res) => {
          // State must be cleared BEFORE the completion callback fires.
          assert.strictEqual(state.decoder, null, 'scenario 1: state cleared at completion');
          assert.strictEqual(state.identity, null, 'scenario 1: identity cleared at completion');
          completed = res;
        },
        onError: (e) => errored.push(e),
        onProgress: () => progressCalls++,
      });
    }
    assert.ok(completed, 'scenario 1: onComplete must fire');
    assert.strictEqual(completed.success, true, 'scenario 1: success');
    assert.ok(completed.duration >= 0, 'scenario 1: duration computed');
    assert.ok(progressCalls > 0, 'scenario 1: onProgress called');
    assert.strictEqual(errored.length, 0, 'scenario 1: no errors');
    console.log('✅ Scenario 1: clean transfer, progress + duration + state reset OK');
  }

  // ── Scenario 2: corrupted header checksum → error → RESET → retry succeeds ──
  {
    const state = { decoder: null, identity: null, startTime: undefined };
    const BAD = (realChecksum + 1) >>> 0;
    let errors = [];
    let completed = null;
    const mk = (seq) => packFrame({
      sessionId, seq, k: enc.k, blockLen, totalLen: container.length,
      payloadFnv: BAD, flags: 0,
    }, enc.encode(seq));
    // Feed enough frames with the WRONG checksum to complete decoding.
    let r = null;
    for (let seq = 0; seq < enc.k + 2 && !(r && r.done); seq++) {
      r = ingestOpticalFrame(state, mk(seq), {
        transferId: 't2',
        onFrame: () => {},
        onComplete: (res) => { completed = res; },
        onError: (e) => errors.push(e),
      });
    }
    assert.ok(errors.length > 0, 'scenario 2: mismatch must be reported');
    assert.match(errors[0], /Checksum mismatch/, 'scenario 2: message mentions mismatch');
    assert.ok(!completed, 'scenario 2: must not complete with bad checksum');
    assert.strictEqual(state.decoder, null, 'scenario 2: decoder RESET after mismatch');
    assert.strictEqual(state.identity, null, 'scenario 2: identity cleared');

    // Now retry with CORRECT frames — must fully recover.
    errors = [];
    for (let seq = 0; seq < enc.k + 10; seq++) {
      const f = packFrame({
        sessionId, seq, k: enc.k, blockLen, totalLen: container.length,
        payloadFnv: realChecksum, flags: 0,
      }, enc.encode(seq));
      ingestOpticalFrame(state, f, {
        transferId: 't2',
        onFrame: () => {},
        onComplete: (res) => { completed = res; },
        onError: (e) => errors.push(e),
      });
    }
    assert.ok(completed && completed.success, 'scenario 2: retry after reset SUCCEEDS');
    console.log('✅ Scenario 2: checksum mismatch → decoder reset → full recovery OK');
  }

  // ── Scenario 3: verifyDeterministicOps self-checks ──
  {
    const { verifyDeterministicOps } = require(path.join(OUT, 'services', 'opticalProtocol.js'));
    const all = verifyDeterministicOps();
    assert.ok(all.ok, 'scenario 3: determinism checks must pass: ' + JSON.stringify(all.checks));
    console.log('✅ Scenario 3: determinism self-checks OK —', all.checks.map(c => c.name).join(', '));
  }

  // ── Scenario 4: SonoDrop two-phase heartbeat (parseReplyToken + buildHeartbeat) ──
  {
    const { parseReplyToken, buildHeartbeat, buildCompositeHeartMessage } =
      require(path.join(OUT, 'protocol', 'sonoDropProtocol.js'));

    // Device reply carrying a 4000-TLV token: "4000" + "0006" + "tok123"
    const reply = '40000006tok123';
    const token = parseReplyToken(reply);
    assert.strictEqual(token, 'tok123', 'scenario 4: token extracted from reply');

    // Heartbeat WITH token must equal the confirmed CompositeHeartMsg shape.
    const hb = buildHeartbeat({ localIP: '192.168.43.7', localPort: 40123, patientId: 'p1', token });
    assert.strictEqual(hb, buildCompositeHeartMessage('tok123'), 'scenario 4: token heartbeat matches CompositeHeartMsg');

    // CompositeHeartMsg exact bytes: [6000][len][0001][6001][tokenLen][token]
    const tokenTlv = `6001${'0006'}tok123`;
    const expected = `6000${String(tokenTlv.length).padStart(4, '0')}0001${tokenTlv}`;
    assert.strictEqual(hb, expected, 'scenario 4: heartbeat bytes match dex-confirmed layout');

    // Garbage reply → null token → legacy fallback still returns a string.
    assert.strictEqual(parseReplyToken('not-a-tlv-stream!!'), null, 'scenario 4: garbage yields null');
    const hbLegacy = buildHeartbeat({ localIP: 'x', localPort: 1, patientId: 'p1' });
    assert.ok(typeof hbLegacy === 'string' && hbLegacy.length > 0, 'scenario 4: legacy fallback non-empty');

    console.log('✅ Scenario 4: two-phase heartbeat (token extract → CompositeHeartMsg) OK');
  }

  console.log('\n🎉 ALL INGEST-RECOVERY TESTS PASSED');
}

main().catch((e) => { console.error('❌ TEST FAILED:', e); process.exit(1); });



