/**
 * OpticalBridge.ts
 *
 * ADDITIVE — ura që mungonte midis skanerit nativ dhe dekoduesit optik.
 *
 * Problemi që zgjidh:
 *   LightScanActivity.kt (CameraX + ZXing) skanonte QR-të dhe i ruante te
 *   MeshStore.kt, një bufer statik në Kotlin. Askush nuk e lexonte këtë
 *   bufer, ndaj "Skano driten" (Drita) lexonte QR por NUK dekodonte asnjë
 *   stream Decimen. OpticalTransferService/LTDecoder ishin krejt të shkëputur.
 *
 * Zgjidhja: pas kthimit nga aktiviteti nativ, drainOpticalFrames() i merr
 * tekstet e skanuara dhe i kalon te decodeOpticalQrData + ingestOpticalFrame
 * — pikërisht funksionet që PairingScreen përdor tashmë për kamerën.
 *
 * ASNJË NDRYSHIM PROTOKOLI. Këtë kod nuk prek opticalProtocol.ts,
 * sonoDropProtocol.ts, framing.ts apo asnjë vendndryshim tjetër — ai thërret
 * vetëm API-të ekzistuese të pacaktuara.
 */
import { NativeModules, Platform } from 'react-native';
import { decodeOpticalQrData, ingestOpticalFrame, type OpticalTransferResult } from './OpticalTransferService';
import type { LTDecoder } from './opticalProtocol';
import { buildOpticalStudyId, ingestReceivedFile } from './studyIngest';

export interface OpticalBridgeEvents {
  /** Frame i ri u pranua (numri total i frame-ve të deduplikuar). */
  onFrame?: (accepted: number) => void;
  /** Progresi i dekodimit: blloqe të zgjidhura / totale. */
  onProgress?: (progress: number, total: number) => void;
  /** Transferi u përfundua dhe skedari u ruajt në ekzaminim. */
  onComplete?: (info: { studyId: string; fileName: string; size: number; path: string }) => void;
  onError?: (message: string) => void;
  /** Numri i tekstit QR të skanuara që nuk ishin frame Decimen (p.sh. QR-ja e P50). */
  onForeign?: (count: number) => void;
}

/** Gjendja e dekoduesit — e njëjta formë që kërkon ingestOpticalFrame. */
interface BridgeState {
  decoder: LTDecoder | null;
  identity: string | null;
  startTime?: number;
}

interface NativeBridge {
  drainOpticalFrames?: () => Promise<string[]>;
  pendingOpticalFrameCount?: () => Promise<number>;
}

function nativeBridge(): NativeBridge | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as Record<string, unknown>).SonoLinkLauncher as NativeBridge | undefined ?? null;
}

/** Sa frame i skanuar akoma nuk janë marrë nga JS. 0 nëse nuk ka modul nativ. */
export async function pendingOpticalFrameCount(): Promise<number> {
  try {
    const n = await nativeBridge()?.pendingOpticalFrameCount?.();
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Hapi i vetëm publik: lexo çdo frame të skanuar nga ana native dhe përpiq
 * ta ndërtoj skedarin. Thirhet pas kthimit nga LightScanActivity.
 *
 * Kthen sa frame u pranuan dhe sa ishin të huaja (jo-Decimen).
 */
export async function drainAndDecodeOpticalFrames(
  state: BridgeState,
  studyIdRef: { current: string },
  events: OpticalBridgeEvents = {},
): Promise<{ accepted: number; foreign: number; completed: boolean }> {
  const bridge = nativeBridge();
  if (!bridge?.drainOpticalFrames) {
    events.onError?.('Moduli nativ SonoLinkLauncher nuk është i ngarkuar (build pa native).');
    return { accepted: 0, foreign: 0, completed: false };
  }

  let texts: string[];
  try {
    texts = await bridge.drainOpticalFrames();
  } catch (e: any) {
    events.onError?.(`Nuk u lexuan frame-t nga ana native: ${e?.message ?? e}`);
    return { accepted: 0, foreign: 0, completed: false };
  }

  let accepted = 0;
  let foreign = 0;
  let completed = false;

  for (const text of texts) {
    // Teksti i skanuar duhet t'i përshtatshohet formatit të frame-it
    // optik (D1C3: base64, ose base64/hex/latin1 si fallback). Nëse nuk
    // është frame Decimen, p.sh. QR-ja e P50-së, kthehet null — nuk është
    // gabim, thjesht nuk i përket këtij dekoduesi.
    const bytes = decodeOpticalQrData(text);
    if (!bytes) {
      foreign++;
      continue;
    }

    if (!studyIdRef.current) studyIdRef.current = buildOpticalStudyId();

    // Held in a mutable object on purpose: TypeScript narrows a plain `let`
    // to `null` after the callback that assigns it, because it assumes the
    // callback is never invoked. ingestOpticalFrame DOES invoke it, and
    // synchronously — but the compiler cannot see across that boundary.
    const outcome: { result: OpticalTransferResult | null } = { result: null };

    ingestOpticalFrame(
      state,
      bytes,
      {
        transferId: 'drita_lightscan',
        onFrame: () => {},
        onProgress: (progress, total) => events.onProgress?.(progress, total),
        onError: (message) => events.onError?.(message),
        onComplete: (r) => {
          outcome.result = r;
        },
      },
    );
    accepted++;
    events.onFrame?.(accepted);

    // ingestOpticalFrame e njofton onComplete sinkronisht kur container-i
    // u reassamblua dhe checksum-i përputhet — pra mund ta trajtojmë menjëherë.
    const result = outcome.result;
    if (result?.success && result.fileBytes && result.fileName) {
      completed = true;
      const studyId = studyIdRef.current;
      try {
        const saved = await ingestReceivedFile(studyId, {
          name: result.fileName,
          bytes: result.fileBytes,
          kind: result.fileType?.toLowerCase().includes('dicom') ? 'DICOM' : 'OPTICAL',
        });
        events.onComplete?.({
          studyId,
          fileName: result.fileName,
          size: saved.size,
          path: saved.path,
        });
      } catch (e: any) {
        events.onError?.(`Skedari u lexua por nuk u ruajt: ${e?.message ?? e}`);
      }
      // Dekoduesi është pastruar nga vetë ingestOpticalFrame pas suksesit,
      // ndaj transferi i ardhshëm fillon i pastër.
    }
  }

  if (foreign > 0) events.onForeign?.(foreign);
  return { accepted, foreign, completed };
}

/** Gjendje e re dekoduesi — përdoret kur ekrani mount-on. */
export function createBridgeState(): BridgeState {
  return { decoder: null, identity: null };
}
