import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';

/**
 * Opens Android's native share sheet. WhatsApp appears when installed and
 * supported; the OS, not the app, controls the final recipient and delivery.
 */
export async function shareFileViaWhatsApp(fileUri: string, message?: string): Promise<boolean> {
  const available = await Sharing.isAvailableAsync();
  if (!available) return false;

  const lowerUri = fileUri.toLowerCase();
  const isPng = lowerUri.endsWith('.png');
  const mimeType = isPng ? 'image/png' : 'image/jpeg';
  const uri = fileUri;
  if (message) {
    // expo-sharing transports files, while the Android share sheet handles the
    // optional text. Keep this branch for future native intent integration.
    void message;
  }
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) throw new Error('Skedari nuk ekziston më në telefon.');
  await Sharing.shareAsync(uri, {
    mimeType,
    dialogTitle: 'Dërgo imazhin te pacienti në WhatsApp',
    UTI: isPng ? 'public.png' : 'public.jpeg',
  });
  return true;
}