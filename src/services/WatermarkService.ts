/**
 * WatermarkService.ts
 *
 * Prepares received images for watermarking and carries the exact watermark
 * text that must be rendered by a native image-marker in production.
 */
import * as ImageManipulator from 'expo-image-manipulator';

export interface WatermarkOptions {
  doctor: string;
  date?: Date;
  clinic?: string;
}

export function formatWatermarkText(options: WatermarkOptions): string {
  const date = options.date ?? new Date();
  const stamp = date.toLocaleString('sq-AL', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${options.clinic ?? 'Klinika ALBURA'}\nDr. ${options.doctor}\n${stamp}`;
}

/**
 * Expo's image manipulator has no text-overlay operation. This keeps the
 * image pipeline loss-bounded and exposes the exact text for a future native
 * marker (react-native-image-marker or an equivalent custom module).
 */
export async function applyWatermark(imageUri: string, _options: WatermarkOptions): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(
    imageUri,
    [{ resize: { width: 1024 } }], // Placeholder action
    { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
  );

  return result.uri;
}
