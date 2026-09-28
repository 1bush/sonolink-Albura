/**
 * sonoDropProtocol.ts
 *
 * Clean-room reimplementation of the QR pairing + control-channel format used
 * by SonoScape's USAlbum / SonoDrop app (com.sonoscape.usalbum), reverse
 * engineered from the decompiled QRInfoParser / TLVHelper classes, and
 * cross-checked against the web prototype built earlier for this project.
 *
 * ============================================================================
 * CONFIRMED against real device bytes (not just inferred from a screenshot):
 *   - QR payload: [msgType:4][totalLen:4][tlvCount:4][TLV_1]...[TLV_6]
 *   - Each TLV: [type:4][len:4][value: len bytes, UTF-8/ASCII]
 *   - msgType 9000, tlvCount 6, types 9001-9006 (SSID/password/encryption/
 *     host/port/patientId)
 *
 *   A real "QR Export" payload was decoded out of photo pixels (jsQR) from
 *   IMG_20260915_194824 and is pinned verbatim in scripts/test-protocol.mjs:
 *     9000 0110 0006 | 9001 0011 "DCOM-ALBURA" | 9002 0010 "al0u5a2b2r"
 *     | 9003 0001 "2" | 9004 0012 "891.561.2.19" | 9005 0005 "99199"
 *     | 9006 0023 "1026_96561123260314_596"
 *
 *   Two details that capture pinned down and a self-built round-trip cannot:
 *     1. `totalLen` counts ONLY the TLV block, not the 12-byte header
 *        (110 == 122 - 12).
 *     2. `len` fields are plain DECIMAL pairs, not hex — a 12-char value is
 *        "0012" and 23 chars is "0023". parseInt(..., 10) is correct;
 *        parseInt(..., 16) would silently truncate both.
 *
 *   Note the QR carries only pairing metadata (~122 bytes), never image bytes.
 *   The 5 files listed in the QR Export dialog travel over TCP/WiFi afterwards,
 *   which is why the optical decoder is right to classify this payload as
 *   foreign rather than a Decimen frame (see optical-bridge-test.cjs).
 *
 * NOT CONFIRMED — best-effort, needs verification against a real packet
 * capture before trusting it with real patient data:
 *   - The heartbeat TLV (3000-3004) and file-ack TLV (2000-2001) shapes below
 *     were present in the earlier web prototype but that prototype never
 *     actually talked to real hardware (it fell back to a simulated/demo
 *     transfer whenever a real socket wasn't available). Treat these as a
 *     documented guess, not a confirmed spec.
 *   - The actual file-transfer framing (how image/cine/report bytes are
 *     sent after the heartbeat) is NOT specified anywhere in the source
 *     material. A 4-digit ASCII length prefix (max 9999) as used for the QR
 *     TLVs cannot carry a 245KB image, so file transfer cannot use the same
 *     framing verbatim. See TcpConnectionService.ts for the placeholder
 *     framing used, and the TODO there for how to confirm it.
 */

export const QR_MSG_TYPE = 9000;
export const QR_TLV_NUM = 6;

/** XOR key seen in the earlier web prototype's P50Crypto class. Purpose/use
 * site unconfirmed — kept here for reference only, not applied anywhere. */
export const LEGACY_XOR_KEY = '19040435';

export const TLV_TYPE = {
  // --- QR pairing payload (CONFIRMED) ---
  SSID: 9001,
  PASSWORD: 9002,
  ENCRYPTION: 9003,
  HOST: 9004,
  PORT: 9005,
  PATIENT_ID: 9006,

  // --- SonoDrop control channel (confirmed from classes.dex) ---
  HEARTBEAT_MESSAGE: 6000,
  HEARTBEAT_TOKEN: 6001,
  TASK_CANCEL: 3100,

  // --- SonoDrop data channel (confirmed from DataTransferThread.<clinit>) ---
  FILE_HEAD: 1000,
  FILE_REPLY: 2000,
  CONTROL: 5000,
  CONTROL_NO_DATA: 5001,

  // --- Device reply (UNCONFIRMED) ---
  REPLY_HEADER: 4000,

  // --- File acknowledgement (UNCONFIRMED) ---
  FILE_ACK_HEADER: 2000,
  FILE_ACK_STATUS: 2001,
} as const;

export const SONODROP_MESSAGE_TYPE = {
  FILE_HEAD: 1000,
  FILE_REPLY: 2000,
  CONTROL: 5000,
  CONTROL_NO_DATA: 5001,
} as const;

/** Metadata fields observed on DataTransferThread.FileHead in classes.dex. */
export interface SonoDropFileHead {
  msgType: string;
  dept: string;
  time: string;
  name: string;
  size: string;
  total: string;
  index: string;
}

/**
 * Parses a file-head field list once the device sends it as a TLV stream.
 * The field order is the order used by FileHead; the exact outer framing is
 * still intentionally left to the captured device bytes.
 */
export function parseSonoDropFileHead(values: string[]): SonoDropFileHead | null {
  if (values.length < 7) return null;
  const [msgType, dept, time, name, size, total, index] = values;
  return { msgType, dept, time, name, size, total, index };
}

export const ENCRYPTION_LABELS: Record<number, string> = {
  0: 'Asnjë',
  1: 'WEP',
  2: 'WPA',
  3: 'WPA-EAP',
};

export type EncryptionType = 'NONE' | 'WEP' | 'WPA2' | '';

export interface SonoDropQRInfo {
  ssid: string;
  password: string;
  encryption: EncryptionType;
  encryptionRaw: number;
  encryptionName: string;
  host: string;
  port: number;
  patientId: string;
  raw: string;
}

interface TLV {
  type: number;
  len: number;
  value: string;
}

function pad4(n: number | string): string {
  return String(n).padStart(4, '0');
}

function decodeEncryptionType(raw: string): EncryptionType {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return '';
  if (n === 0) return 'NONE';
  if (n === 1) return 'WEP';
  if (n === 2 || n === 3) return 'WPA2';
  return '';
}

function encodeEncryptionType(e: EncryptionType): string {
  switch (e) {
    case 'NONE':
      return '0';
    case 'WEP':
      return '1';
    case 'WPA2':
      return '2';
    default:
      return '0';
  }
}

/** Generic TLV-stream tokenizer shared by QR payloads and control-channel
 * messages. Returns every TLV found, in order, tolerant of trailing junk. */
function tokenizeTLVStream(data: string): TLV[] {
  const out: TLV[] = [];
  let cursor = 0;
  while (cursor + 8 <= data.length) {
    const type = parseInt(data.substring(cursor, cursor + 4), 10);
    const len = parseInt(data.substring(cursor + 4, cursor + 8), 10);
    if (Number.isNaN(type) || Number.isNaN(len) || len < 0) break;
    cursor += 8;
    if (cursor + len > data.length) break;
    const value = data.substring(cursor, cursor + len);
    cursor += len;
    out.push({ type, len, value });
  }
  return out;
}

/**
 * Parses a raw QR string produced by the ultrasound machine's "QR Export"
 * screen. Throws on any structural mismatch instead of silently returning a
 * half-empty object.
 */
export function parseSonoDropQR(raw: string): SonoDropQRInfo {
  const bytes = raw;
  if (bytes.length < 12) {
    throw new Error('QR payload too short to contain header');
  }

  let cursor = 0;

  const msgType = parseInt(bytes.substring(cursor, cursor + 4), 10);
  cursor += 4;
  if (msgType !== QR_MSG_TYPE) {
    throw new Error(`Unexpected QR msg type: ${msgType}, expected ${QR_MSG_TYPE}`);
  }

  const totalLen = parseInt(bytes.substring(cursor, cursor + 4), 10);
  cursor += 4;
  if (Number.isNaN(totalLen) || totalLen > bytes.length) {
    throw new Error(`Invalid total length field: ${totalLen}`);
  }

  const tlvCount = parseInt(bytes.substring(cursor, cursor + 4), 10);
  cursor += 4;
  if (tlvCount !== QR_TLV_NUM) {
    throw new Error(`Unexpected TLV count: ${tlvCount}, expected ${QR_TLV_NUM}`);
  }

  const rest = bytes.substring(cursor);
  const tlvs = tokenizeTLVStream(rest);
  const tlvMap = new Map<number, TLV>();
  for (const t of tlvs) tlvMap.set(t.type, t);

  const get = (t: number): string => {
    const tlv = tlvMap.get(t);
    if (!tlv) throw new Error(`Missing TLV type ${t}`);
    return tlv.value;
  };

  const encryptionRaw = parseInt(get(TLV_TYPE.ENCRYPTION), 10) || 0;

  return {
    ssid: get(TLV_TYPE.SSID),
    password: get(TLV_TYPE.PASSWORD),
    encryption: decodeEncryptionType(get(TLV_TYPE.ENCRYPTION)),
    encryptionRaw,
    encryptionName: ENCRYPTION_LABELS[encryptionRaw] ?? 'Panjohur',
    host: get(TLV_TYPE.HOST),
    port: parseInt(get(TLV_TYPE.PORT), 10),
    patientId: get(TLV_TYPE.PATIENT_ID),
    raw,
  };
}

/** Best-effort parse: never throws, returns null on failure. Useful for the
 * manual-entry modal where we want a friendly error instead of a crash. */
export function tryParseSonoDropQR(raw: string): SonoDropQRInfo | null {
  try {
    return parseSonoDropQR(raw);
  } catch {
    return null;
  }
}

/**
 * Builds a QR payload string in the same format, in case you need YOUR side
 * to emit a QR that a stock USAlbum/SonoDrop-compatible scanner can read, or
 * for round-trip testing against parseSonoDropQR.
 */
export function buildSonoDropQR(info: {
  ssid: string;
  password: string;
  encryption: EncryptionType;
  host: string;
  port: number;
  patientId: string;
}): string {
  const fields: Array<[number, string]> = [
    [TLV_TYPE.SSID, info.ssid],
    [TLV_TYPE.PASSWORD, info.password],
    [TLV_TYPE.ENCRYPTION, encodeEncryptionType(info.encryption)],
    [TLV_TYPE.HOST, info.host],
    [TLV_TYPE.PORT, String(info.port)],
    [TLV_TYPE.PATIENT_ID, info.patientId],
  ];

  const tlvStrings = fields.map(([type, value]) => `${pad4(type)}${pad4(value.length)}${value}`);
  const tlvBlock = tlvStrings.join('');
  const totalLen = 4 + tlvBlock.length;

  return `${pad4(QR_MSG_TYPE)}${pad4(totalLen)}${pad4(QR_TLV_NUM)}${tlvBlock}`;
}

/**
 * Extracts the registration token from the device's reply after the TCP
 * connection opens. Shape (per HeartBeatThread / ParseReplyClientMsg in
 * classes.dex): the device replies with a TLV stream whose REPLY_HEADER
 * (type 4000) value carries the token string. The token is then echoed back
 * in the heartbeat via buildCompositeHeartMessage.
 *
 * Still UNCONFIRMED against a live capture — if the reply uses a different
 * TLV type or a raw (non-TLV) token, parseReplyToken returns null and the
 * caller must fall back (see TcpConnectionService's two-phase heartbeat).
 *
 * @returns The token string, or null if no 4000-TLV is found.
 */
export function parseReplyToken(raw: string): string | null {
  const tlvs = tokenizeTLVStream(raw);
  for (const t of tlvs) {
    if (t.type === TLV_TYPE.REPLY_HEADER && t.value.length > 0) return t.value;
  }
  return null;
}

/**
 * Builds the heartbeat/registration message the phone sends to the scanner.
 *
 * CONFIRMED two-phase flow (from HeartBeatThread in classes.dex):
 *   1. Phone opens the TCP socket and WAITS for the device's reply.
 *   2. The reply carries a registration token (see parseReplyToken).
 *   3. Phone sends CompositeHeartMsg with that token:
 *      [6000][len][0001][6001][token len][token]
 *
 * The legacy one-shot shape (device-patient fields baked in) was never
 * observed on real hardware and is kept ONLY as a fallback when no token
 * could be extracted — treat it as a compatibility shim, not a spec.
 */
export function buildHeartbeat(params: {
  localIP: string;
  localPort: number;
  patientId: string;
  username?: string;
  /** Registration token extracted from the device reply (preferred path). */
  token?: string;
}): string {
  if (params.token) {
    return buildCompositeHeartMessage(params.token);
  }
  // Legacy fallback: no token available. Kept for compatibility with the
  // old one-shot flow; does NOT implement a complete registration.
  void params.localIP;
  void params.localPort;
  void params.username;
  return buildCompositeHeartMessage(params.patientId);
}

/**
 * Confirmed from HeartBeatThread.CompositeHeartMsg(String):
 *   [6000][length of TLV][0001][6001][token length][token]
 * All fields are four-character decimal ASCII and the token is UTF-8.
 */
export function buildCompositeHeartMessage(token: string): string {
  const tokenTlv = `${pad4(TLV_TYPE.HEARTBEAT_TOKEN)}${pad4(token.length)}${token}`;
  return `${pad4(TLV_TYPE.HEARTBEAT_MESSAGE)}${pad4(tokenTlv.length)}${pad4(1)}${tokenTlv}`;
}

/** Builds the cancellation message used by HeartBeatThread.CompositeCancelMsg. */
export function buildCompositeCancelMessage(value: string): string {
  const valueTlv = `${pad4(TLV_TYPE.TASK_CANCEL)}${pad4(value.length)}${value}`;
  return `${pad4(TLV_TYPE.TASK_CANCEL)}${pad4(valueTlv.length)}${pad4(1)}${valueTlv}`;
}

/**
 * Builds a file-received acknowledgement. UNCONFIRMED shape.
 */
export function buildFileAck(fileIndex: number, status: 0 | 1 = 0): string {
  const statusStr = `${fileIndex}:${status}`;
  const fields: Array<[number, string]> = [
    [TLV_TYPE.FILE_ACK_HEADER, ''],
    [TLV_TYPE.FILE_ACK_STATUS, statusStr],
  ];
  return fields.map(([type, value]) => `${pad4(type)}${pad4(value.length)}${value}`).join('');
}

/** Parses any generic TLV control-message (heartbeat replies, etc.) coming
 * back from the device on the same channel. Returns a type->value map.
 * UNCONFIRMED — the device's reply shape has never been observed. */
export function parseControlMessage(raw: string): Map<number, string> {
  const tlvs = tokenizeTLVStream(raw);
  const map = new Map<number, string>();
  for (const t of tlvs) map.set(t.type, t.value);
  return map;
}
