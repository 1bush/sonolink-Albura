/**
 * sonodropCrypto.ts
 *
 * Detects and handles the encrypted file transfer.
 *
 * WHAT THE DECOMPILED APK SHOWS
 * The SonoDrop native library (libklnetio.so) exposes two JNI entry points:
 *
 *   KLNetIO::DecryptFile(String)  -> native
 *   KLNetIO::DecryptValue(String) -> native   (two-arg in Java: key, value)
 *
 * and DataTransferThread writes every received file with a ".enc" suffix and
 * calls DecryptFile before use. HomeFragment and RemoteFragment call
 * DecryptValue on the three values that come out of the QR payload:
 *
 *   DecryptValue(mPsswd, mIP)
 *   DecryptValue(mPsswd, mPort)
 *
 * So the WiFi password from the QR payload is the decryption key. There is a
 * hard-coded 8-character literal "19040435" in .rodata next to the fopen and
 * ".enc" strings, which is a static key or salt.
 *
 * WHY THERE IS NO DECRYPT IMPLEMENTATION HERE
 * The actual algorithm lives inside KFileEncrypt::Encryption, a stripped
 * AArch64 function. Disassembling it established that it is NOT a simple XOR:
 * the whole 0.8 MB library contains exactly 36 EOR instructions, and only ONE
 * of them is inside KFileEncrypt, while DecryptFile contains none at all.
 * There is no AES, DES, RC4, MD5, SHA or Base64 anywhere in its strings or
 * symbols either, so it is a custom construction. Reproducing that from a
 * stripped binary without a proper disassembler would be guesswork, and
 * shipping a guess on a medical decryption path is worse than shipping none.
 *
 * WHAT THIS DOES INSTEAD
 * It recognises an encrypted payload and refuses to hand raw ciphertext to the
 * gallery or the DICOM decoder. That is the real failure mode worth
 * preventing: without this, a .enc file would sail through FileFrameReader,
 * fail fileKinds' signature check, and be saved as a corrupt "unknown" file
 * that the user would later open and find broken.
 */
import { Buffer } from 'buffer';

/** The hard-coded literal found in libklnetio.so's .rodata. */
export const SONODROP_STATIC_KEY = '19040435';

/** The suffix DataTransferThread appends to a received file. */
export const ENC_SUFFIX = '.enc';

export interface CryptoVerdict {
  /** True when the bytes are SonoDrop ciphertext. */
  encrypted: boolean;
  /** What we can do about it, in words for a log or the UI. */
  reason: string;
}

/**
 * Detects SonoDrop ciphertext.
 *
 * Two independent signals, because either alone is weak:
 *   1. the name carries the .enc suffix the device adds
 *   2. the bytes match no format signature fileKinds recognises
 *
 * Signal 1 alone is not enough (someone could name a real file .enc) and
 * signal 2 alone is not enough (a truncated transfer looks the same), so both
 * must hold before anything is called encrypted.
 */
export function detectEncryptedTransfer(name: string, bytes: Uint8Array): CryptoVerdict {
  const namedEnc = name.toLowerCase().endsWith(ENC_SUFFIX);
  const looksLikeCipherText = !hasAnyKnownSignature(bytes);

  if (namedEnc && looksLikeCipherText) {
    return {
      encrypted: true,
      reason:
        `SonoDrop encrypted file (${ENC_SUFFIX}). The key is the WiFi password from the QR payload, ` +
        'and libklnetio.so holds a custom algorithm we have not reproduced.',
    };
  }
  if (namedEnc) {
    return {
      encrypted: false,
      reason: 'Named .enc but the bytes carry a real format signature, so it is not encrypted.',
    };
  }
  return { encrypted: false, reason: 'Not an encrypted SonoDrop transfer.' };
}

/**
 * True when the bytes start with a signature we recognise.
 *
 * Deliberately conservative: it only has to answer "is this definitely
 * readable", so it checks the same fixed offsets fileKinds uses. A false
 * negative here means a file is treated as ciphertext, which is the safe
 * direction — the user is told it could not be read rather than being handed
 * a file that opens as garbage.
 */
function hasAnyKnownSignature(bytes: Uint8Array): boolean {
  const startsWith = (offset: number, ascii: string): boolean => {
    if (offset + ascii.length > bytes.length) return false;
    for (let i = 0; i < ascii.length; i++) {
      if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
    }
    return true;
  };
  return (
    startsWith(128, 'DICM') || // DICOM
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) || // JPEG
    startsWith(0, '\x89PNG\r\n\x1a\n') || // PNG
    startsWith(0, 'BM') || // BMP
    startsWith(0, '%PDF-') || // PDF
    startsWith(4, 'ftyp') || // MP4
    (startsWith(0, 'RIFF') && startsWith(8, 'AVI ')) // AVI
  );
}

/**
 * Marks a name as encrypted rather than pretending to decrypt it.
 *
 * Naming a ciphertext payload "IMG_0001.jpg" would produce a file that looks
 * valid and opens as garbage; naming it "IMG_0001.jpg.enc" makes the state of
 * the data obvious to anyone who finds it later.
 */
export function markEncryptedName(name: string): string {
  if (name.toLowerCase().endsWith(ENC_SUFFIX)) return name;
  return `${name}${ENC_SUFFIX}`;
}

/**
 * A stable identifier for a key, without ever holding the key itself.
 *
 * Lets a log say "this study needs the same password as that one" without
 * recording either password. FNV-1a is not cryptographic and is not meant to
 * be: it only distinguishes same-password from different-password.
 */
export function keyFingerprint(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Bytes helper for callers that already hold a Buffer. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}
