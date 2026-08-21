import {
  packFile,
  unpackFile,
  packFrame,
  parseFrame,
  LTEncoder,
  LTDecoder,
  fnv1a,
} from '../src/services/opticalProtocol';

async function main() {
  // Build a sample "image" payload
  const payload = new Uint8Array(2500);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) & 0xff;

  const packed = await packFile('IMG_0001.jpg', 'image/jpeg', payload);
  console.log('container len =', packed.container.length, 'compression =', packed.compression);

  const container = packed.container;
  const checksum = fnv1a(container);
  const blockLen = 64;
  const sessionId = 1234;
  const totalLen = container.length;

  // Encode and decode: capture EVERY frame in order
  const encoder = new LTEncoder(container, blockLen, sessionId);
  const decoder = new LTDecoder(encoder.k, blockLen, sessionId, totalLen);
  let sent = 0;
  for (let seq = 0; seq < 2 * encoder.k + 5; seq++) {
    const block = encoder.encode(seq);
    const frame = packFrame(
      { sessionId, seq, k: encoder.k, blockLen, totalLen, payloadFnv: checksum, flags: 0 },
      block,
    );
    sent++;
    const parsed = parseFrame(frame);
    if (!parsed) throw new Error('frame did not parse');
    decoder.addFrame(parsed.header.seq, parsed.block);
  }
  console.log('sent frames =', sent, 'k =', encoder.k, 'decoder complete =', decoder.isComplete);

  const rebuilt = decoder.assemble();
  if (!rebuilt) throw new Error('no assembly');
  console.log('rebuilt container len =', rebuilt.length, 'matches =', fnv1a(rebuilt) === checksum);

  const file = unpackFile(rebuilt);
  console.log('unpacked name =', file.name, 'type =', file.type, 'bytes =', file.bytes.length);
  const ok = file.bytes.length === payload.length;
  let same = ok;
  for (let i = 0; i < payload.length; i++) if (payload[i] !== file.bytes[i]) same = false;
  console.log(same && file.name === 'IMG_0001.jpg' ? 'ROUND-TRIP PASSED' : 'ROUND-TRIP FAILED');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});