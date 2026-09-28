/**
 * studyIngest.ts
 *
 * ADDITIVE — "ruaj skedarin e marrë në ekzaminim" si një funksion i vetëm,
 * i ndarë nga PairingScreen.
 *
 * Pse: ruajtja e skedarit + regjistrimi në SQLite ishte e shkruar brenda
 * PairingScreen.handleUnifiedFile, pra ishte e arritshme vetëm nga skaneri
 * i kamera-s. Rruga optike nativ (Drita LightScan) dhe dërguesi Decimen
 * kishin nevojë të bëjnë të njëjtën gjë, pa qenë në gjendje ta bëjnë.
 *
 * Ky modul thithet NGA TË DYJA rrugët. Nuk ndryshon asnjë protokol: ai thërret
 * vetëm saveFrame / upsertStudy / insertSop / incrementStudyFileCount, që
 * ishin tashmë të importuara nga PairingScreen.
 */
import { Buffer } from 'buffer';
import { ensureStudyDir } from './fileStorage';
import { insertSop, incrementStudyFileCount, upsertStudy } from './database';
import { DicomService } from './DicomService';
import { identifyFile } from './fileKinds';
import { saveReceivedFile, type SaveReport } from './gallerySaver';

/** Të dhënat e nevojshme për të ruajtur një skedar të marrë. */
export interface IngestFile {
  name: string;
  bytes: Buffer | Uint8Array;
  /** 'DICOM' | 'IMG ' | 'OPTICAL' … — vendoset nga rruga që e mori skedarin. */
  kind: string;
}

export interface IngestResult {
  path: string;
  size: number;
  /** i pari nëse skedari ishte DICOM dhe u parsua me sukses. */
  dicom: { patientName?: string; modality?: string; rows?: number; columns?: number } | null;
  /** Çfarë ndodhi me galerinë, dhe çfarë format u provua realisht. */
  save?: SaveReport;
}

/**
 * Ruaj një skedar të marrë brenda dosjes së ekzaminimit, regjistroje në
 * SQLite dhe rrite numrin e skedarëve.
 *
 * Krijon ekzaminimin nëse nuk ekziston ende (kjo ndodh kur transferi vjen
 * pa një QR SonoDrop që ta ketë themeluar më parë — pikërisht rasti optik).
 */
export async function ingestReceivedFile(
  studyId: string,
  file: IngestFile,
  options: { index?: number; dept?: string } = {},
): Promise<IngestResult> {
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);

  await ensureStudyDir(studyId);
  await upsertStudy({
    ID: studyId,
    DateTime: new Date().toISOString(),
    Dept: options.dept ?? 'OPTICAL',
    Num: 0,
  });

  // saveFrame() vetëm e shkruante skedarin dhe e prekte galerinë për
  // jpg/png/jpeg. P50 dërgon edhe BMP, MP4/AVI, PDF dhe DICOM, të gjitha të
  // pashoqura. saveReceivedFile() i njeh nga bajtët dhe i vendos secilin atje
  // ku përdoruesi mund t'i gjejë.
  const saved = await saveReceivedFile(studyId, file.name, bytes);
  const identity = identifyFile(file.name, bytes);

  // P50 dërgon JPG/BMP/AVI/PDF, jo DICOM — prandaj kjo pjesë lahet vetëm
  // kur skedari vërtetë ka header DICM. DicomService nuk hedh asnjëherë:
  // kthen null për çdo gjë që nuk është DICOM.
  let dicom: IngestResult['dicom'] = null;
  if (identity.kind === 'dicom') {
    try {
      const meta = DicomService.parse(bytes);
      if (meta) {
        dicom = {
          patientName: meta.patientName,
          modality: meta.modality,
          rows: meta.rows,
          columns: meta.columns,
        };
      }
    } catch {
      dicom = null; // skedar i dëmtuar nuk prish gjithçka
    }
  }

  await insertSop({
    Name: file.name,
    Dir: studyId,
    Size: String(bytes.length),
    Status: 'received',
    Idx: options.index ?? 0,
    StudyID: studyId,
  });
  await incrementStudyFileCount(studyId);

  return { path: saved.path, size: saved.size, dicom, save: saved };
}

/**
 * Ndërto një ID ekzaminimi nga ID-ja e pacientit që vjen në QR-në e P50.
 * Përdor formatin që përdor edhe PairingScreen, që të mbeten të njëjta
 * dosje nëse një ekzaminim kalon nga një rrugë te tjetra.
 */
export function buildOpticalStudyId(patientId?: string): string {
  const suffix = patientId && patientId.trim() ? patientId.trim() : 'optical';
  return `${Date.now()}_${suffix}`;
}