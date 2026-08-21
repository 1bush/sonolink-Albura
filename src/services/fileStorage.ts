/**
 * fileStorage.ts
 */
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import type { ReceivedFileFrame } from './framing';
import { applyWatermark, formatWatermarkText } from './WatermarkService';

const ROOT_DIR = `${FileSystem.documentDirectory}SonoLink/`;
export const DEFAULT_DOCTOR = 'Rovena Stroni';

export function studyDir(studyId: string): string {
  return `${ROOT_DIR}${studyId}/`;
}

export async function ensureStudyDir(studyId: string): Promise<string> {
  const dir = studyDir(studyId);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

export async function saveFrame(
  studyId: string,
  frame: ReceivedFileFrame,
  options: { doctor?: string; receivedAt?: Date } = {},
): Promise<{ path: string; size: number; watermarkText?: string }> {
  const dir = await ensureStudyDir(studyId);
  const safeName = frame.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `file_${Date.now()}`;
  const path = `${dir}${safeName}`;
  const base64 = frame.bytes.toString('base64');
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });

  // Add Watermark and Save to Gallery if it's an image
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.png') || lowerPath.endsWith('.jpeg')) {
    try {
      const watermarkText = formatWatermarkText({
        doctor: options.doctor ?? DEFAULT_DOCTOR,
        date: options.receivedAt,
      });
      const watermarkedUri = await applyWatermark(path, {
        doctor: options.doctor ?? DEFAULT_DOCTOR,
        date: options.receivedAt,
      });
      // Keep the processed copy as the shareable file in the study folder.
      // The current Expo-only marker preserves/normalizes the image; a native
      // text renderer can replace applyWatermark without changing this flow.
      const processedPath = `${dir}watermarked_${safeName.replace(/\.[^.]+$/, '')}.jpg`;
      if (watermarkedUri !== processedPath) {
        await FileSystem.copyAsync({ from: watermarkedUri, to: processedPath });
      }

      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status === 'granted') {
        const asset = await MediaLibrary.createAssetAsync(processedPath);
        const albumName = 'Klinika ALBURA';
        let album = await MediaLibrary.getAlbumAsync(albumName);
        if (album === null) {
          await MediaLibrary.createAlbumAsync(albumName, asset, false);
        } else {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        }
      }
    } catch (e) {
      console.error('Gallery save error:', e);
    }
  }

  return { path, size: frame.bytes.length };
}

export async function listStudyFiles(studyId: string): Promise<string[]> {
  const dir = studyDir(studyId);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) return [];
  return FileSystem.readDirectoryAsync(dir);
}

export async function deleteStudyFiles(studyId: string): Promise<void> {
  const dir = studyDir(studyId);
  const info = await FileSystem.getInfoAsync(dir);
  if (info.exists) {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  }
}

export async function ensureRootDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(ROOT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(ROOT_DIR, { intermediates: true });
  }
}
