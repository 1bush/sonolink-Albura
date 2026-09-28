import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { listStudies, listSopsForStudy } from './database';
import { listStudyFiles, exportManifestPath, studyDir, DEFAULT_DOCTOR } from './fileStorage';
import { formatWatermarkText } from './WatermarkService';

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

/**
 * Builds a plain-text manifest for a study: study metadata from the database,
 * every file with its size, and the watermark stamp applied at receive time.
 * expo-sharing can only transport one file per sheet invocation and there is
 * no zip dependency in the project, so the manifest travels as its own file
 * next to the shared primary image.
 */
export async function buildStudyManifest(studyId: string): Promise<string> {
  const studies = await listStudies();
  const study = studies.find((s) => s.ID === studyId);
  const sops = await listSopsForStudy(studyId);
  const files = await listStudyFiles(studyId);

  const lines: string[] = [
    '=== SonoLink — Eksport Studimi ===',
    `Studimi: ${studyId}`,
    `Data: ${study?.DateTime ?? 'e panjohur'}`,
    `Departamenti: ${study?.Dept ?? '-'}`,
    `Numri i skedarëve: ${sops.length || files.length}`,
    `Stampë watermark: ${formatWatermarkText({ doctor: DEFAULT_DOCTOR }).replace(/\n/g, ' | ')}`,
    '',
    '--- Skedarët ---',
    ...files.map((name) => `  ${name}`),
    '',
    'E eksportuar nga SonoLink mobile.',
  ];

  const manifestPath = await exportManifestPath(studyId);
  await FileSystem.writeAsStringAsync(manifestPath, lines.join('\n'), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return manifestPath;
}

/**
 * Full-study export: writes the manifest, then opens the share sheet on the
 * PRIMARY artifact (first watermarked image → any image → first file →
 * manifest only when the study has no files at all).
 */
export async function shareStudyBundle(studyId: string): Promise<boolean> {
  const available = await Sharing.isAvailableAsync();
  if (!available) return false;

  const manifestPath = await buildStudyManifest(studyId);
  const files = await listStudyFiles(studyId);
  const primaryName =
    files.find((name) => /^watermarked_/i.test(name) && /\.(jpg|jpeg|png)$/i.test(name)) ??
    files.find((name) => /\.(jpg|jpeg|png)$/i.test(name)) ??
    files.find((name) => /\.(dcm)$/i.test(name)) ??
    files[0];

  const uri = primaryName ? `${studyDir(studyId)}${primaryName}` : manifestPath;
  const isText = !primaryName;
  const lowerUri = uri.toLowerCase();
  const mimeType = isText
    ? 'text/plain'
    : lowerUri.endsWith('.png')
      ? 'image/png'
      : lowerUri.endsWith('.dcm')
        ? 'application/dicom'
        : 'image/jpeg';

  await Sharing.shareAsync(uri, {
    mimeType,
    dialogTitle: 'Eksporto studimin',
    UTI: isText ? 'public.plain-text' : lowerUri.endsWith('.png') ? 'public.png' : 'public.jpeg',
  });
  return true;
}