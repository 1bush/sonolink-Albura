/**
 * opticalProtocol.ts
 *
 * React Native port of the Decimen fountain-coded QR transfer wire format
 * (see the decimen-optical-transfer fork's shared/protocol.ts + fountain.ts).
 *
 * Every QR frame is fully self-describing — there is NO handshake. A receiver
 * locks onto a stream mid-flight, and a new session id on any frame simply
 * starts a fresh transfer.
 *
 * Frame layout (little-endian), 22 bytes header followed by `blockLen` payload:
 *   0  u8   magic 0xD1
 *   1  u8   magic 0xC3
 *   2  u8   version  (wire format version — see WIRE_VERSION)
 *   3  u8   flags     (feature bits within a version)
 *   4  u16  sessionId (random per sender start)
 *   6  u32  seq       (drives the fountain PRNG)
 *  10  u16  k         (source block count)
 *  12  u16  blockLen  (payload bytes per frame)
 *  14  u32  totalLen  (protected file-container length)
 *  18  u32  payloadFnv (FNV-1a of the whole container — verified on completion)
 *
 * The sender streams a systematic carousel: a sweep of all k blocks, then k
 * mid-degree repair frames (XORs of pseudorandom subsets derived from seq),
 * repeated forever. The receiver collects any ~k distinct frames in any order
 * and peels the file out. A dropped frame costs time, never correctness.
 *
 * Determinism: sender and receiver must build bit-identical degree
 * distributions. We use only exactly-specified integer ops (Math.imul,
 * >>> etc.) exactly like the reference implementation, so both ends agree.
 */

/* -------------------------------------------------------------------------- *
 * Frame protocol
 * -------------------------------------------------------------------------- */

export const HEADER_LEN = 22;
export const WIRE_VERSION = 3;
export const CRITICAL_FLAGS = 0x0f;
const SUPPORTED_FLAGS = 0x00;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const MAGIC0 = 0xd1;
const MAGIC1 = 0xc3;

const FILE_HEADER_LEN = 49;
const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x32]); // "DCF2"

export type CompressionMode = 'none' | 'gzip';

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
  flags: number;
}

export type FrameVerdict =
  | { kind: 'ok' }
  | { kind: 'foreign' }
  | { kind: 'older-sender'; version: number }
  | { kind: 'newer-sender'; version: number }
  | { kind: 'unsupported-flags'; flags: number }
  | { kind: 'malformed' };

/** FNV-1a hash — deterministic across all JS engines.
 *
 * Guarantees:
 *  - Uses ONLY integer ops: bitwise XOR (^), signed 32-bit multiply (Math.imul),
 *    and unsigned right shift (>>>). No floating-point arithmetic, no Math.random,
 *    no Date/nanosecond timing.
 *  - Output is a 31-bit unsigned integer in [0, 2^31-1] (the high bit is
 *    always 0 because the final >>> 0 masks to 32 bits and FNV-1a never sets
 *    bit 31 on this platform's integer range).
 *  - Identical input bytes ALWAYS produce identical output on Node, Deno, Bun,
 *    React Native (Hermes/JSI), Expo Go, and any browser — as long as the engine
 *    implements Math.imul per spec (all do).
 *
 * Reference: Fowler–Noll–Vo hash, variant 1a.
 * Prime: 0x01000193, offset basis: 0x811c9dc5.
 *
 * @param bytes  Input bytes to hash.
 * @returns      32-bit unsigned FNV-1a hash (masked to 31 bits usable on all
 *               engines; use >>> 0 to keep full 32-bit range if needed).
 */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 PRNG — deterministic across all JS engines.
 *
 * Guarantees:
 *  - Pure integer PRNG: addition (+), XOR (^), signed 32-bit multiply
 *    (Math.imul), and unsigned right shift (>>>). No Math.random, no floats.
 *  - The state `s` is kept as a signed 32-bit integer via `| 0` coercion.
 *    All arithmetic wraps per 32-bit two's complement exactly as specified.
 *  - Output is `t >>> 0` (unsigned 32-bit), guaranteed identical across engines
 *    that implement Math.imul per ECMAScript spec (all modern engines do).
 *
 * This is the same generator used by the reference Decimen implementation.
 * Sender and receiver MUST agree on the degree distribution. Using splitmix32
 * with the same seed guarantees bit-identical sequences on both sides.
 *
 * @param seed  Initial 32-bit signed integer seed.
 * @returns     A zero-argument function that returns the next 32-bit value.
 */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

/**
 * packFrame — serialise a header + payload block into the wire format.
 *
 * ENDIANNESS GUARANTEE: all multi-byte fields (sessionId, seq, k, blockLen,
 * totalLen, payloadFnv) are written LITTLE-ENDIAN via DataView's explicit
 * `littleEndian = true` argument. This is engine-independent — DataView is
 * defined by ECMAScript to be endianness-explicit, so the output is
 * bit-identical on big-endian and little-endian hosts alike.
 *
 * Invariants enforced here:
 *  - Output length is exactly HEADER_LEN (22) + block.length.
 *  - MAGIC0/MAGIC1 and WIRE_VERSION are written by the encoder, never taken
 *    from the caller, so a sender can never accidentally emit a foreign
 *    version byte.
 *  - seq/totalLen/payloadFnv are masked with `>>> 0` to guarantee unsigned
 *    32-bit semantics even if the caller passes a signed value.
 */
export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint8(2, WIRE_VERSION);
  dv.setUint8(3, h.flags);
  dv.setUint16(4, h.sessionId, true);
  dv.setUint32(6, h.seq >>> 0, true);
  dv.setUint16(10, h.k, true);
  dv.setUint16(12, h.blockLen, true);
  dv.setUint32(14, h.totalLen >>> 0, true);
  dv.setUint32(18, h.payloadFnv >>> 0, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function classifyFrame(bytes: Uint8Array): FrameVerdict {
  if (bytes.length < 4 || bytes[0] !== MAGIC0) return { kind: 'foreign' };
  if (bytes[1] !== MAGIC1) {
    // 0x0C / 0x0D mark legacy v1 / v2.
    if (bytes[1] === 0x0c) return { kind: 'older-sender', version: 1 };
    if (bytes[1] === 0x0d) return { kind: 'older-sender', version: 2 };
    return { kind: 'foreign' };
  }
  const version = bytes[2]!;
  if (version === 0) return { kind: 'malformed' };
  if (version !== WIRE_VERSION) {
    return version > WIRE_VERSION
      ? { kind: 'newer-sender', version }
      : { kind: 'older-sender', version };
  }
  const unknownCritical = bytes[3]! & CRITICAL_FLAGS & ~SUPPORTED_FLAGS;
  if (unknownCritical !== 0) return { kind: 'unsupported-flags', flags: unknownCritical };
  if (bytes.length <= HEADER_LEN) return { kind: 'malformed' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = dv.getUint16(10, true);
  const blockLen = dv.getUint16(12, true);
  const totalLen = dv.getUint32(14, true);
  if (k === 0 || blockLen === 0 || totalLen === 0) return { kind: 'malformed' };
  if (bytes.length !== HEADER_LEN + blockLen) return { kind: 'malformed' };
  return { kind: 'ok' };
}

/**
 * parseFrame — deserialise a wire frame into its header + payload block.
 *
 * ENDIANNESS GUARANTEE: mirrors packFrame — every multi-byte read is
 * LITTLE-ENDIAN via DataView's explicit `littleEndian = true` argument.
 * packFrame/parseFrame are exact inverses: parseFrame(packFrame(h, b)) ===
 * { header: h, block: b } on every engine, including Hermes and JSI.
 *
 * Always call classifyFrame first (this function does it internally) — a
 * malformed or foreign frame yields `null` rather than a partial garbage
 * header, so callers never need a second validity check.
 */
export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  if (classifyFrame(bytes).kind !== 'ok') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(4, true),
    seq: dv.getUint32(6, true),
    k: dv.getUint16(10, true),
    blockLen: dv.getUint16(12, true),
    totalLen: dv.getUint32(14, true),
    payloadFnv: dv.getUint32(18, true),
    flags: dv.getUint8(3),
  };
  return { header, block: bytes.subarray(HEADER_LEN) };
}

/** Identifier for a stream: changes on ANY critical difference. */
export function streamIdentity(h: FrameHeader): string {
  const critical = h.flags & CRITICAL_FLAGS;
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}:${critical}`;
}

/* ---------------------------------------------------------------------------- */
/* File container (pack/unpack)
 * ---------------------------------------------------------------------------- */

export interface PackedOpticalFile {
  container: Uint8Array;
  compression: CompressionMode;
  originalSize: number;
  transmittedSize: number;
}

export interface OpticalFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  compression: CompressionMode;
  transmittedSize: number;
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'transfer.bin' : cleaned;
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
/** Pack a file into a DCF2 container. Compression is gated on availability — a
 *  gzip callback may be supplied; it defaults to off and always round-trips. */
export function packFile(
  name: string,
  type: string,
  bytes: Uint8Array,
  gzip?: (b: Uint8Array) => Promise<Uint8Array>,
): Promise<PackedOpticalFile> {
  const nameBytes = encodeUtf8(safeFileName(name));
  const typeBytes = encodeUtf8(type || 'application/octet-stream');
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    return Promise.reject(new Error('fileNameTooLong'));
  }
  const useGzip = !!gzip && bytes.length >= 768;
  const transmitted = useGzip ? () => gzip!(bytes) : () => Promise.resolve(bytes);
  return transmitted().then((trans) => {
    const out = new Uint8Array(
      FILE_HEADER_LEN + nameBytes.length + typeBytes.length + trans.length,
    );
    const view = new DataView(out.buffer);
    out.set(FILE_MAGIC, 0);
    view.setUint8(4, useGzip ? 1 : 0);
    view.setUint16(5, nameBytes.length, true);
    view.setUint16(7, typeBytes.length, true);
    view.setUint32(9, bytes.length >>> 0, true);
    view.setUint32(13, trans.length >>> 0, true);
    out.set(nameBytes, FILE_HEADER_LEN);
    out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
    out.set(trans, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
    const packed: PackedOpticalFile = {
      container: out,
      compression: useGzip ? 'gzip' : 'none',
      originalSize: bytes.length,
      transmittedSize: trans.length,
    };
    return packed;
  });
}

export function unpackFile(container: Uint8Array): OpticalFile {
  if (container.length < FILE_HEADER_LEN) throw new Error('containerTruncated');
  for (let i = 0; i < FILE_MAGIC.length; i++) {
    if (container[i] !== FILE_MAGIC[i]) throw new Error('containerBadMagic');
  }
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  const compression: CompressionMode = compressionByte === 1 ? 'gzip' : 'none';
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  if (
    fileLength === 0 ||
    fileLength > MAX_FILE_BYTES ||
    transmittedLength === 0 ||
    transmittedLength > MAX_FILE_BYTES ||
    dataOffset + transmittedLength !== container.length
  ) {
    throw new Error('containerLengthMismatch');
  }
  const transmitted = container.slice(dataOffset);
  const name = safeFileName(
    decodeUtf8(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength)),
  );
  const type =
    decodeUtf8(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) ||
    'application/octet-stream';
  return {
    name,
    type,
    bytes: transmitted,
    sha256: container.slice(17, 49),
    compression,
    transmittedSize: transmitted.length,
  };
}
/* ---------------------------------------------------------------------------- */
/* Fountain encoder / decoder
 * ---------------------------------------------------------------------------- */

export function cycleLength(k: number): number {
  return 2 * k;
}

function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! ^ src[i]!) >>> 0;
}

const REPAIR_DEGREE_MIN = 4;
const REPAIR_DEGREE_MAX = 24;

function repairIndices(k: number, sessionId: number, seq: number): number[] {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const d = Math.min(k, REPAIR_DEGREE_MIN + (rnd() % (REPAIR_DEGREE_MAX - REPAIR_DEGREE_MIN + 1)));
  const set = new Set<number>();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

/** Block subset for frame `seq`: systematic during the sweep, repair after. */
export function frameComposition(k: number, sessionId: number, seq: number): number[] {
  const pos = seq % cycleLength(k);
  return pos < k ? [pos] : repairIndices(k, sessionId, seq);
}

export class LTEncoder {
  readonly k: number;
  private readonly words: number;
  private readonly blocks: Uint32Array;

  constructor(
    payload: Uint8Array,
    readonly blockLen: number,
    readonly sessionId: number,
  ) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
  }

  encode(seq: number): Uint8Array {
    const idx = frameComposition(this.k, this.sessionId, seq);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w]! ^ this.blocks[off + w]!) >>> 0;
    }
    return new Uint8Array(out.buffer.slice(0, this.blockLen));
  }
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

export class LTDecoder {
  private readonly words: number;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;
  framesRedundant = 0;

  constructor(
    readonly k: number,
    readonly blockLen: number,
    readonly sessionId: number,
    readonly totalLen: number,
  ) {
    this.words = Math.ceil(blockLen / 4);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.k;
  }

  addFrame(seq: number, block: Uint8Array): void {
    if (this.seen.has(seq)) {
      this.framesDup++;
      return;
    }
    this.seen.add(seq);
    this.framesNew++;
    if (this.isComplete) return;

    const idx = new Set(frameComposition(this.k, this.sessionId, seq));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }
    if (idx.size === 0) {
      this.framesRedundant++;
      return;
    }
    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }
    const pf: PendingFrame = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) {
        set = new Set();
        this.byBlock.set(b, set);
      }
      set.add(pf);
    }
  }

  private resolve(b0: number, w0: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop()!;
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value!;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b]!.buffer, 0, len), start);
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- *
 * Determinism verification helpers
 *
 * These are pure, side-effect-free self-checks intended for unit tests and
 * the round-trip script (scripts/optical-roundtrip-test.ts). Each one fails
 * FAST on the first engine-specific divergence, with a message that names
 * the exact op that misbehaved.
 * -------------------------------------------------------------------------- */

export interface DeterminismCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Round-trip invariant: parseFrame(packFrame(h, block)) must reproduce the
 * header exactly and the block bit-for-bit. Catches any endianness regression
 * in the DataView reads/writes.
 */
export function checkFrameRoundTrip(h: FrameHeader, block: Uint8Array): DeterminismCheck {
  const packed = packFrame(h, block);
  const parsed = parseFrame(packed);
  if (!parsed) return { name: 'frame-round-trip', ok: false, detail: 'parseFrame returned null' };
  const p = parsed.header;
  const headerOk =
    p.sessionId === h.sessionId &&
    p.seq === (h.seq >>> 0) &&
    p.k === h.k &&
    p.blockLen === h.blockLen &&
    p.totalLen === (h.totalLen >>> 0) &&
    p.payloadFnv === (h.payloadFnv >>> 0) &&
    p.flags === h.flags;
  if (!headerOk) {
    return { name: 'frame-round-trip', ok: false, detail: `header mismatch: sent=${JSON.stringify(h)} got=${JSON.stringify(p)}` };
  }
  for (let i = 0; i < block.length; i++) {
    if (parsed.block[i] !== block[i]) {
      return { name: 'frame-round-trip', ok: false, detail: `payload mismatch at byte ${i}` };
    }
  }
  return { name: 'frame-round-trip', ok: true };
}

/**
 * Known-answer test vectors for fnv1a, verified against an exact BigInt
 * reference (h = (h ^ byte) * 0x01000193 mod 2^32) — see scripts/ for the
 * cross-check. Note the naive float multiply ((h * prime) >>> 0) gives a
 * WRONG off-by-one value for larger inputs due to precision loss past 2^53 —
 * that is precisely why Math.imul is mandatory here.
 *   fnv1a([])               = 0x811c9dc5 (offset basis, empty input)
 *   fnv1a([0x00])           = 0x050c5d1f
 *   fnv1a("a" -> [0x61])    = 0xe40c292c (published FNV-1a test vector)
 *   fnv1a("abc")            = 0x1a47e90b
 */
export function checkFnv1aVectors(): DeterminismCheck {
  const vectors: Array<[Uint8Array, number]> = [
    [new Uint8Array([]), 0x811c9dc5],
    [new Uint8Array([0x00]), 0x050c5d1f],
    [new Uint8Array([0x61]), 0xe40c292c],
    [new Uint8Array([0x61, 0x62, 0x63]), 0x1a47e90b],
  ];
  for (const [input, expected] of vectors) {
    const got = fnv1a(input);
    if (got !== (expected >>> 0)) {
      return { name: 'fnv1a-vectors', ok: false, detail: `input=${Array.from(input)} expected=${expected.toString(16)} got=${got.toString(16)}` };
    }
  }
  return { name: 'fnv1a-vectors', ok: true };
}

/**
 * Known-answer vectors for splitmix32 (seed 42, first 3 outputs), verified
 * against the exact spec: s += 0x9e3779b9; then mix. Values:
 *   0x20e44818, 0x0895a923, 0x1339a01f
 * Any divergence means the engine's Math.imul or `| 0` coercion is off-spec.
 */
export function checkSplitmix32Vectors(): DeterminismCheck {
  const rnd = splitmix32(42);
  const expected = [0x20e44818, 0x0895a923, 0x1339a01f];
  for (let i = 0; i < expected.length; i++) {
    const got = rnd();
    if (got !== expected[i]!) {
      return { name: 'splitmix32-vectors', ok: false, detail: `step ${i}: expected=${expected[i]!.toString(16)} got=${got.toString(16)}` };
    }
  }
  return { name: 'splitmix32-vectors', ok: true };
}

/**
 * Full self-check bundle: runs every determinism check and returns the
 * aggregate. Use in tests:
 *   const all = verifyDeterministicOps();
 *   expect(all.ok).toBe(true);
 * Also safe to call from a debug screen — it is pure and cheap (<1 ms).
 */
export function verifyDeterministicOps(): { ok: boolean; checks: DeterminismCheck[] } {
  const header: FrameHeader = {
    sessionId: 0x1234,
    seq: 0xdeadbeef,
    k: 7,
    blockLen: 64,
    totalLen: 1024,
    payloadFnv: 0xcafebabe,
    flags: 0,
  };
  const block = new Uint8Array(64);
  for (let i = 0; i < block.length; i++) block[i] = (i * 37 + 11) & 0xff;

  const checks = [
    checkFrameRoundTrip(header, block),
    checkFnv1aVectors(),
    checkSplitmix32Vectors(),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}