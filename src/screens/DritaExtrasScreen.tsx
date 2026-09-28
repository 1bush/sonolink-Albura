// DritaExtrasScreen.tsx — ADDITIVE: ekran i ri "Drita optike" per SonoLink.
// Nuk prek HomeScreen/PairingScreen/OpticalScreen. Hap 3 aktivitetet nativ
// (LightScan / Kap+OCR / Solar sensor) pa ndryshuar flow-n P50/Decimen.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ToastAndroid, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../theme';
import { openDritaActivity, type DritaActivityKey } from '../services/drita/dritaLauncher';
import {
  createBridgeState,
  drainAndDecodeOpticalFrames,
  pendingOpticalFrameCount,
} from '../services/OpticalBridge';

const ITEMS: { key: DritaActivityKey; icon: keyof typeof Ionicons.glyphMap; title: string; desc: string }[] = [
  { key: 'lightScan', icon: 'scan-outline', title: 'Skano driten (QR nativ)', desc: 'CameraX + ZXing, me flash HazeCast. Per QR Export te P50 dhe QR-stream Decimen.' },
  { key: 'decimenSender', icon: 'qr-code-outline', title: 'Dergo (QR) — Decimen', desc: 'Derguesi i brendshem me picker nativ: skedari plahet si QR animacion i Kodimit LX.' },
  { key: 'capture', icon: 'camera-outline', title: 'Kap + OCR (pa QR)', desc: 'Foto ekranin e aparatit; teksti lexohet offline dhe kopjohet vete.' },
  { key: 'solar', icon: 'sunny-outline', title: 'Solar — sensori i drites', desc: 'Lexon blicin me sensorin TYPE_LIGHT, pa kamera e pa leje.' },
];

export default function DritaExtrasScreen() {
  const [busy, setBusy] = useState<DritaActivityKey | null>(null);
  /** Frame të skanuar nga ana native që nuk janë marrë ende nga JS. */
  const [pending, setPending] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const bridgeState = useRef(createBridgeState());
  const studyIdRef = useRef('');

  const refreshPending = useCallback(async () => {
    setPending(await pendingOpticalFrameCount());
  }, []);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  /**
   * Kur përdoruesi kthehet nga LightScanActivity, aktiviteti nativ është
   * ndarë dhe MeshStore mbushur me QR-të e skanuara. I lexojmë dhe i
   * kalojmë te LTDecoder. Nuk ndryshon asnjë protokoll.
   */
  const drain = useCallback(async () => {
    setStatus(null);
    setProgress(null);
    const result = await drainAndDecodeOpticalFrames(bridgeState.current, studyIdRef, {
      onProgress: (done, total) => setProgress({ done, total }),
      onComplete: ({ fileName, size }) => {
        setProgress(null);
        setStatus(`✓ ${fileName} (${(size / 1024).toFixed(1)} KB) u ruajt në ALBUM.`);
        ToastAndroid.show(`U ruajt: ${fileName}`, ToastAndroid.LONG);
      },
      onError: (message) => {
        setProgress(null);
        setStatus(`✗ ${message}`);
      },
      onForeign: (count) => {
        if (count > 0) setStatus(`${count} QR nuk ishin frame Decimen (p.sh. QR-ja e P50).`);
      },
    });
    await refreshPending();
    if (result.accepted === 0 && result.foreign === 0) setStatus('Asnjë frame i ri.');
  }, [refreshPending]);

  async function open(key: DritaActivityKey) {
    setBusy(key);
    const ok = await openDritaActivity(key);
    setBusy(null);
    if (!ok) {
      ToastAndroid.show('Moduli nativ hapet pas build-it Android (dev-client/APK).', ToastAndroid.LONG);
      return;
    }
    // Hapja e aktivitetit nativen e ndalon ekranin; kur përdoruesi kthehet,
    // i konsumojmë frame-t që skanoi atje.
    if (key === 'lightScan') {
      setTimeout(() => void drain(), 600);
    }
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>SONOLINK + DRITA — SHTESE OPTIKE</Text>
        <Text style={styles.title}>Drita optike (pa rrjet)</Text>
        <Text style={styles.sub}>
          Këto hapen si aktivitete nativ Android, krahas flow-t ekzistues P50 (WiFi/QR) dhe
          Decimen (QR-stream). Asgje nga ekrani yt aktual nuk ndryshon.
        </Text>

        {/* Paneli i uras optike — i vetmi vend ku lidhet skaneri nativ me LTDecoder. */}
        <View style={styles.bridgeCard}>
          <View style={styles.bridgeHeader}>
            <Ionicons name="git-merge-outline" size={18} color={theme.colors.primaryLight} />
            <Text style={styles.bridgeTitle}>Ura optike</Text>
            {pending > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{pending}</Text>
              </View>
            )}
          </View>
          <Text style={styles.bridgeDesc}>
            {pending > 0
              ? `${pending} frame të skanuar presin të deshifrohen.`
              : 'Skano një stream QR nga një pajisje tjetër, pastaj kthehu këtu.'}
          </Text>
          <TouchableOpacity
            style={styles.bridgeBtn}
            onPress={() => void (pending > 0 ? drain() : open('lightScan'))}
            activeOpacity={0.8}
            disabled={busy !== null}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#06231F" />
            ) : (
              <Ionicons
                name={pending > 0 ? 'download-outline' : 'scan-outline'}
                size={16}
                color="#06231F"
              />
            )}
            <Text style={styles.bridgeBtnText}>
              {busy ? 'Po hapet…' : pending > 0 ? 'Deshifro dhe ruaj' : 'Skano dritën'}
            </Text>
          </TouchableOpacity>
          {progress && progress.total > 0 && (
            <View style={styles.progressBlock}>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` },
                  ]}
                />
              </View>
              <Text style={styles.progressText}>
                {progress.done}/{progress.total} blloqe
              </Text>
            </View>
          )}
          {status && <Text style={styles.statusText}>{status}</Text>}
        </View>

        {ITEMS.map((it) => (
          <TouchableOpacity key={it.key} style={styles.card} onPress={() => void open(it.key)} activeOpacity={0.85}>
            <View style={styles.iconBox}>
              <Ionicons name={it.icon} size={24} color={theme.colors.primaryLight} />
            </View>
            <View style={styles.info}>
              <Text style={styles.cardTitle}>{it.title}</Text>
              <Text style={styles.cardDesc}>{it.desc}</Text>
              {busy === it.key && <Text style={styles.busy}>Po hapet…</Text>}
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        ))}
        <Text style={styles.note}>
          Teksti i shkurter (ID pacient) udheton me LightCodecs (preamble AA AA + CRC16,
          8N1 200ms); file-at e rende vazhdojne me Decimen/TCP si me pare.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, gap: 12 },
  kicker: { color: theme.colors.textMuted, fontSize: 11, letterSpacing: 1, fontWeight: '700' },
  title: { color: theme.colors.textPrimary, fontSize: 22, fontWeight: '700' },
  sub: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.backgroundCard,
    padding: 16,
    borderRadius: 20,
    gap: 14,
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(47,184,169,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, gap: 2 },
  cardTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700' },
  cardDesc: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16 },
  busy: { color: theme.colors.primaryLight, fontSize: 12, marginTop: 2 },
  note: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 15, marginTop: 6 },
  // ── Paneli i uras optike ──
  bridgeCard: {
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 20,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  bridgeHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bridgeTitle: { flex: 1, color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700' },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#06231F', fontSize: 12, fontWeight: '700' },
  bridgeDesc: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
  bridgeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  bridgeBtnText: { color: '#06231F', fontWeight: '700', fontSize: 13 },
  progressBlock: { gap: 4 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: theme.colors.primary },
  progressText: { color: theme.colors.textMuted, fontSize: 11 },
  statusText: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 },
});
