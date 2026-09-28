// dritaLauncher.ts — ADDITIVE: hap aktivitetet optike nativ Drita->SonoLink pa
// prekur asnje screen ekzistues. Përdoret nga ekrani i ri DritaExtrasScreen.
// Android-only: thërret NativeModules/Intent direkt; ne iOS/web kthen false.
import { NativeModules, Platform } from 'react-native';

/**
 * Emrat e aktiviteteve nativ te regjistruara ne AndroidManifest (blloku ADDITIVE).
 *
 * `decimenSender` ishte i regjistruar dhe i koduar, por ABSENT këtu — ndaj
 * askush nuk mund ta hapej nga UI. Me këtë shtesë bëhet i arritshëm nga
 * DritaExtrasScreen pa ndryshuar asnjë manifest.
 */
export const DRITA_ACTIVITIES = {
  lightScan: 'al.albura.sonolink.drita.LightScanActivity',
  capture: 'al.albura.sonolink.drita.DritaCaptureActivity',
  solar: 'al.albura.sonolink.drita.SolarSensorActivity',
  decimenSender: 'al.albura.sonolink.DecimenSenderActivity',
} as const;

export type DritaActivityKey = keyof typeof DRITA_ACTIVITIES;

/**
 * Hap nje aktivitet nativ me Intent eksplicit.
 * Kthen true nese u dergua, false ne iOS/web ose kur mungon moduli.
 */
export async function openDritaActivity(key: DritaActivityKey): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const cls = DRITA_ACTIVITIES[key];
  try {
    const launcher =
      (NativeModules as Record<string, { openActivity?: (cls: string) => Promise<boolean> } | undefined>)
        .SonoLinkLauncher;
    if (launcher?.openActivity) return (await launcher.openActivity(cls)) === true;
    // Fallback pa modul nativ: Linking nuk hap dot class eksplicit pa modul,
    // keshtu qe kthejme false dhe UI tregon udhezimin manual.
    return false;
  } catch {
    return false;
  }
}
