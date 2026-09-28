/**
 * gallerySaver.ts
 *
 * Puts a received file where the user can actually find it, and handles the
 * formats the old saveFrame() ignored.
 *
 * WHAT saveFrame() USED TO DO
 * It wrote the bytes to the study folder and only touched the gallery for
 * .jpg/.jpeg/.png. Everything else the P50 offers — BMP stills, MP4/AVI cine
 * loops, the PDF report, and DICOM itself — was written to disk and never
 * appeared in the gallery. For a clinician that means the study "arrived" and
 * then cannot be found in Photos.
 *
 * WHAT THIS DOES INSTEAD
 *   photo (jpg/png/bmp) -> gallery, as a photo
 *   video (mp4)        -> gallery, as a video
 *   dicom              -> decoded to PNG, THEN saved to the gallery
 *   avi, pdf           -> study folder only, and reported as such
 *
 * Why AVI and PDF stay out: Android's MediaStore has no row type for either
 * (an AVI would be indexed as a broken image, a PDF as nothing at all), and
 * iOS's camera roll has no PDF type either. Pretending otherwise produces a
 * gallery entry that opens to an error, which is worse than no entry.
 *
 * The original file is always kept in the study folder regardless — the gallery
 * is a convenience, the folder is the record.
 */
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Buffer } from 'buffer';
import { decodeDicomToRgb, encodePng } from './DicomImage';
import { correctedName, identifyFile, type FileIdentity } from './fileKinds';
import { ensureStudyDir } from './fileStorage';
import { formatWatermarkText } from './WatermarkService';

export const GALLERY_ALBUM = 'Klinika ALBURA';

export type SaveOutcome = 'gallery-photo' | 'gallery-video' | 'folder-only' | 'folder-only-failed';

export interface SaveReport {
  /** Where the original bytes were written inside the study folder. */
  path: string;
  size: number;
  /** What the bytes turned out to be. */
  identity: FileIdentity;
  /** What happened to the gallery. */
  outcome: SaveOutcome;
  /**
   * The gallery URI, when one was created. For a DICOM this is the decoded
   * PNG, not the .dcm file.
   */
  galleryUri?: string;
  /** Paths of the PNGs written for a multi-frame DICOM. */
  framePngs?: string[];
  /** Why nothing reached the gallery, in words meant for the user. */
  reason?: string;
}

/** Writes bytes to `path` as raw binary. */
async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  await FileSystem.writeAsStringAsync(path, Buffer.from(bytes).toString('base64'), {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Asks for permission once, and reports failure instead of throwing.
 *
 * A refused gallery permission must not abort the save: the file is already on
 * disk by then, and losing it because of a permission prompt would be a much
 * worse outcome than an invisible gallery entry.
 */
async function withGalleryPermission<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') return { ok: false };
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

/** Puts an asset in the album, creating the album on first use. */
async function addToAlbum(assetPath: string): Promise<string> {
  const asset = await MediaLibrary.createAssetAsync(assetPath);
  const album = await MediaLibrary.getAlbumAsync(GALLERY_ALBUM);
  if (album === null) {
    await MediaLibrary.createAlbumAsync(GALLERY_ALBUM, asset, false);
  } else {
    await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
  }
  return asset.uri;
}

/**
 * Decodes a DICOM file to PNG images in the study folder.
 *
 * Every frame is written, not just the first: a cine study with 200 frames
 * would otherwise lose 199 of them. Each PNG is named after the frame index so
 * they sort in acquisition order inside the folder.
 */
async function writeDicomFrames(
  dir: string,
  stem: string,
  bytes: Uint8Array,
): Promise<{ pngs: string[]; error?: string }> {
  const decoded = decodeDicomToRgb(bytes);
  if (!decoded.ok) {
    return { pngs: [], error: decoded.detail };
  }
  const pngs: string[] = [];
  decoded.frames.forEach((frame, index) => {
    // encodePng returns a plain Uint8Array so the module stays free of the
    // Buffer polyfill on device; writeBinary re-wraps it for expo-file-system.
    const png = encodePng(frame.width, frame.height, frame.rgb);
    const path = `${dir}${stem}_f${String(index).padStart(3, '0')}.png`;
    pngs.push(path);
    // writeBinary is async, but the loop is synchronous by design: building a
    // list first keeps the frames in index order without awaiting in a loop.
    void writeBinary(path, png);
  });
  return { pngs };
}

/**
 * Saves one received file: study folder always, gallery when the format allows.
 *
 * `name` is whatever the P50 called the file; it is corrected to match the
 * actual bytes before writing, because the device mislabels its own exports.
 */
export async function saveReceivedFile(
  studyId: string,
  name: string,
  bytes: Uint8Array,
): Promise<SaveReport> {
  const identity = identifyFile(name, bytes);
  const dir = await ensureStudyDir(studyId);

  const safeRaw = name.replace(/[^a-zA-Z0-9._-]/g, '_') || `file_${Date.now()}`;
  const safeName = correctedName(safeRaw, identity);
  const path = `${dir}${safeName}`;
  await writeBinary(path, bytes);

  const stem = safeName.replace(/\.[^.]+$/, '');

  // ── DICOM: decode, then put the PNGs in the gallery ──
  if (identity.kind === 'dicom') {
    const { pngs, error } = await writeDicomFrames(dir, stem, bytes);
    if (error || pngs.length === 0) {
      return {
        path,
        size: bytes.length,
        identity,
        outcome: 'folder-only',
        reason: error ?? 'DICOM held no image frames.',
      };
    }
    // Only the first frame goes to the gallery: a 200-frame cine would bury
    // every other study's images under hundreds of entries. All frames stay
    // in the study folder.
    const first = pngs[0]!;
    const granted = await withGalleryPermission(() => addToAlbum(first));
    if (!granted.ok) {
      return {
        path,
        size: bytes.length,
        identity,
        outcome: 'folder-only',
        framePngs: pngs,
        reason: 'Gallery permission refused; the decoded frames are in the study folder.',
      };
    }
    return {
      path,
      size: bytes.length,
      identity,
      outcome: 'gallery-photo',
      galleryUri: granted.value,
      framePngs: pngs,
    };
  }

  // ── Formats the media library cannot represent ──
  if (identity.galleryAction === 'none') {
    return {
      path,
      size: bytes.length,
      identity,
      outcome: 'folder-only',
      reason: identity.note,
    };
  }

  // ── Photo or video the library understands ──
  const granted = await withGalleryPermission(() => addToAlbum(path));
  if (!granted.ok) {
    return {
      path,
      size: bytes.length,
      identity,
      outcome: 'folder-only',
      reason: 'Gallery permission refused; the file is in the study folder.',
    };
  }
  return {
    path,
    size: bytes.length,
    identity,
    outcome: identity.galleryAction === 'video' ? 'gallery-video' : 'gallery-photo',
    galleryUri: granted.value,
  };
}

/** A one-line summary for the UI, in Albanian to match the rest of the app. */
export function describeOutcome(report: SaveReport): string {
  const kind = report.identity.kind.toUpperCase();
  switch (report.outcome) {
    case 'gallery-photo':
      return report.identity.kind === 'dicom'
        ? `${kind} u zbërthye në PNG dhe u ruajt në galeri.`
        : `${kind} u ruajt në galeri.`;
    case 'gallery-video':
      return `Video ${kind} u ruajt në galeri.`;
    case 'folder-only':
      return `${kind} u ruajt vetëm në dosjen e ekzaminimit. ${report.reason ?? ''}`.trim();
    default:
      return `${kind} u ruajt në dosjen e ekzaminimit.`;
  }
}

/** Exported so the UI can show the doctor's name on saved stills. */
export { formatWatermarkText };

