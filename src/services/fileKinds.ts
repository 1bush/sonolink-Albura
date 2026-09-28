/**
 * fileKinds.ts
 *
 * Identifies what a received file actually IS, from its bytes.
 *
 * WHY NOT JUST THE EXTENSION
 * The P50's "QR Export" screen offers Images BMP/JPG, Cines AVI/MP4 and
 * Report PDF, and the device names its files inconsistently — a cine loop
 * sometimes arrives as ".jpg" and a still frame as ".bmp". Writing each file to
 * the gallery based on its name therefore misfiles it, and an unrecognised
 * file is silently dropped from the gallery entirely.
 *
 * So the name is only a tie-breaker. The magic bytes decide, because every one
 * of these formats has a fixed signature at a fixed offset:
 *
 *   JPEG  FF D8 FF                          (SOI + marker)
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   BMP   42 4D ("BM") + file size at 2..6
 *   DICOM "DICM" at offset 128 (PS3.10) or a bare explicit-VR header at 0
 *   MP4   "....ftyp" at offset 4 (ISO base media)
 *   AVI   "RIFF" + "AVI " at offset 8
 *   PDF   "%PDF-"
 *
 * This module is deliberately dependency-free — no Expo, no React Native — so
 * it can be unit-tested in plain Node like the rest of the protocol code.
 */

export type FileKind =
  | 'dicom'
  | 'jpeg'
  | 'png'
  | 'bmp'
  | 'mp4'
  | 'avi'
  | 'pdf'
  | 'unknown';

/** What the gallery can be asked to do with each kind. */
export type GalleryAction = 'photo' | 'video' | 'none';

export interface FileIdentity {
  kind: FileKind;
  /** True when the bytes matched a signature, not the name. */
  fromContent: boolean;
  /** The extension the bytes imply. */
  suggestedExtension: string;
  /** What may be done with this in the phone's media library. */
  galleryAction: GalleryAction;
  /** Set when there is something the user should know. */
  note?: string;
}

const EXTENSION_FOR: Record<Exclude<FileKind, 'unknown'>, string> = {
  dicom: '.dcm',
  jpeg: '.jpg',
  png: '.png',
  bmp: '.bmp',
  mp4: '.mp4',
  avi: '.avi',
  pdf: '.pdf',
};

const GALLERY_FOR: Record<Exclude<FileKind, 'unknown'>, GalleryAction> = {
  dicom: 'none',
  jpeg: 'photo',
  png: 'photo',
  bmp: 'photo',
  mp4: 'video',
  // Android's MediaStore has no PDF row and iOS's camera roll neither, so a
  // report has to stay in the app's own directory and be shared from there.
  avi: 'none',
  pdf: 'none',
};

const NOTE_FOR: Partial<Record<FileKind, string>> = {
  dicom: 'Decoded to PNG before saving to the gallery.',
  avi: 'AVI cannot be stored by the Android media library; kept in the study folder.',
  pdf: 'The media library has no PDF type; kept in the study folder for sharing.',
};

function matches(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function byteAt(bytes: Uint8Array, i: number): number {
  return i < bytes.length ? bytes[i]! : -1;
}

/** VRs that may legally follow a 32-bit tag in an explicit-VR element. */
const IMPLICIT_VR_NAMES = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'US', 'UL', 'UI'];

/**
 * Reads the format out of the bytes alone. Returns null when nothing matches.
 *
 * A null here is the normal case for a transfer that is still in flight: a real
 * P50 cine loop is megabytes, so a short read must not be guessed at.
 */
export function detectKindFromBytes(bytes: Uint8Array): FileKind | null {
  // DICOM: PS3.10 puts "DICM" at offset 128. Some writers omit the preamble, so
  // also accept an explicit-VR element starting at offset 0.
  if (matches(bytes, 128, 'DICM')) return 'dicom';
  if (bytes.length >= 8) {
    const vr = String.fromCharCode(byteAt(bytes, 4), byteAt(bytes, 5));
    if (IMPLICIT_VR_NAMES.includes(vr)) {
      // A DICOM group is even and below 0x0100 in practice; requiring that
      // rejects the chance that arbitrary bytes spell a two-letter VR here.
      const group = byteAt(bytes, 1);
      if (group > 0 && group < 64) return 'dicom';
    }
  }

  if (byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8 && byteAt(bytes, 2) === 0xff) {
    return 'jpeg';
  }
  if (matches(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (matches(bytes, 0, 'BM')) return 'bmp';
  if (matches(bytes, 0, '%PDF-')) return 'pdf';
  if (matches(bytes, 4, 'ftyp')) return 'mp4';
  if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'AVI ')) return 'avi';

  return null;
}

/** The extension a name claims, lower-cased and without the dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

const NAME_TO_KIND: Record<string, FileKind> = {
  dcm: 'dicom',
  dicom: 'dicom',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  bmp: 'bmp',
  mp4: 'mp4',
  mov: 'mp4',
  avi: 'avi',
  pdf: 'pdf',
};

/**
 * Identifies a file from its bytes, falling back to its name.
 *
 * The fallback exists for one real case: a file that is still arriving. A cine
 * loop that has only delivered its first few kilobytes carries no readable
 * signature yet, and without the name there would be nothing to do with it.
 * Once enough bytes have arrived the content wins, so a mislabelled file
 * corrects itself.
 */
export function identifyFile(name: string, bytes: Uint8Array): FileIdentity {
  const byContent = detectKindFromBytes(bytes);
  const byName = NAME_TO_KIND[extensionOf(name)] ?? null;
  const kind = byContent ?? byName ?? 'unknown';

  if (kind === 'unknown') {
    return {
      kind,
      fromContent: false,
      suggestedExtension: '',
      galleryAction: 'none',
      note: 'Unrecognised format; kept in the study folder only.',
    };
  }

  return {
    kind,
    fromContent: byContent !== null,
    suggestedExtension: EXTENSION_FOR[kind as Exclude<FileKind, 'unknown'>],
    galleryAction: GALLERY_FOR[kind as Exclude<FileKind, 'unknown'>],
    note:
      byContent !== null
        ? NOTE_FOR[kind]
        : 'No signature in the received bytes yet; identified by name only.',
  };
}

/**
 * Renames a file so its extension matches what the bytes actually are.
 *
 * The P50 names files inconsistently, and a study folder full of "IMG_0001.jpg"
 * entries that are really MP4 confuses both the user and the share manifest.
 */
export function correctedName(name: string, identity: FileIdentity): string {
  if (identity.kind === 'unknown' || identity.suggestedExtension === '') return name;
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  return `${stem}${identity.suggestedExtension}`;
}
