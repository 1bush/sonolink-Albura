// OpticalScreen.tsx — Transferim Optik (QR) i integruar nga Decimen
// Optical Transfer (AGPL-3.0-or-later, (c) Evan Crawley / Bash Alarmist).
// Faqet standalone (self-contained HTML me JS/CSS/WASM inline) gjenden në
// android/app/src/main/assets/optical/ dhe ngarkohen direkt nga WebView —
// gjithçka lokale, pa rrjet (CSP e faqeve e ndalon vetë çdo origjinë).
//
// SONOLINK v2.3 — automatizim i plotë:
// - "Skano me Kamera": kamera nis VETE (pa buton Start) dhe settings-et e
//   marrjes zgjidhen nga sistemi (width/fps/workers/camera).
// - "Transfer settings" e dërguesit zgjidhen nga sistemi (fps/bytes/ecc/
//   layout/size) — pa selektim manual; paneeli vetëm mbyllet.
// - Kur skanimi mbaron, FOTO/VIDEO ruhet AUTOMATIKISHT në galeri
//   (albumi "SonoLink") përmes expo-media-library — pa buton Save.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ToastAndroid } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Camera } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../theme';

type Mode = 'send' | 'receive';

const OPTICAL_BASE = 'file:///android_asset/optical/';

/**
 * Auto-tune + auto-save, injektohet PARA ngarkimit të faqes (të dyja mode).
 * Sender: fps=30 (pa flicker telefoni-telefoni), bytes=max, ECC=M, layout
 * 2 kode (1×2, balanc shpejtësi/fideli), size=max — paneeli mbyllet.
 * Receiver: width=1280, fps=60, workers=navigator.hardwareConcurrency-1,
 * kamera back/auto — kamera nis vete; kur transferi mbaron, elementi
 * a.download në #result lexohet si blob → base64 → postMessage te nativja
 * që ta ruajë në galeri (MediaStore) përmes expo-media-library.
 */
const INJECT_AUTO = `
(function(){
  if (window.__SONOLINK_AUTO__) return; window.__SONOLINK_AUTO__ = true;
  function setSel(id, val){
    var el = document.getElementById(id); if (!el) return;
    var opt = [].slice.call(el.options || []).find(function(o){ return o.value === val || o.text === val; });
    el.value = opt ? (opt.value != null ? opt.value : val) : val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function collapseSettings(){
    [].slice.call(document.querySelectorAll('details')).forEach(function(d){
      var s = d.querySelector('summary');
      if (s && /settings/i.test(s.textContent || '')) d.open = false;
    });
  }
  function autoSaveHook(){
    var savedOnce = false;
    function grab(a){
      try {
        fetch(a.href).then(function(r){ return r.blob(); }).then(function(b){
          var fr = new FileReader();
          fr.onload = function(){
            var d = String(fr.result || '');
            var b64 = d.slice(d.indexOf(',') + 1);
            if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'sonolink-autosave',
              name: a.download || 'sono-' + Date.now() + '.jpg',
              mime: b.type || 'image/jpeg',
              b64: b64
            }));
          };
          fr.readAsDataURL(b);
        }).catch(function(){});
      } catch (e) {}
    }
    var result = document.getElementById('result');
    if (!result) return;
    new MutationObserver(function(){
      if (savedOnce) return;
      var a = result.querySelector('a.download');
      if (a) { savedOnce = true; grab(a); }
    }).observe(result, { childList: true, subtree: true });
  }
  function tune(){
    var isReceiver = !!document.getElementById('start');
    if (isReceiver) {
      setSel('cfg-width', '1280');
      setSel('cfg-capfps', '60');
      setSel('cfg-camera', '');
      var w = document.getElementById('cfg-workers');
      if (w) {
        var n = Math.min(6, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
        w.value = String(n);
        w.dispatchEvent(new Event('change', { bubbles: true }));
      }
      collapseSettings();
      autoSaveHook();
      // Kamera nis VETE — pa prekur "Start camera". Nëse leja s'qe akoma
      // dhënë, faqja e mesazhizon vetë; provojmë edhe njëherë pas 2s.
      setTimeout(function(){ var b = document.getElementById('start'); if (b) b.click(); }, 400);
      setTimeout(function(){
        var b = document.getElementById('start');
        if (b && b.offsetParent !== null) b.click();
      }, 2000);
    } else {
      setSel('cfg-fps', '30');
      setSel('cfg-bytes', '2953');
      setSel('cfg-ecc', 'M');
      setSel('cfg-grid', '2');
      var size = document.getElementById('cfg-size');
      if (size) {
        size.value = size.max || '1200';
        size.dispatchEvent(new Event('input', { bubbles: true }));
        size.dispatchEvent(new Event('change', { bubbles: true }));
      }
      collapseSettings();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tune);
  else tune();
})();
true;
`;

export interface OpticalScreenProps {
  /** Hap tab-in "Skan" (SonoDrop QR + TCP) — rruga reale SonoScape P50 → telefon. */
  onOpenP50Scan?: () => void;
}

export default function OpticalScreen({ onOpenP50Scan }: OpticalScreenProps) {
  const [mode, setMode] = useState<Mode>('send');
  // Leja e kamerës kërkohet dhe PRITET para se të hapet faqja e marrjes —
  // kështu auto-start-i i kamerës (klik i injektuar) e gjen lejen gati.
  const [permReady, setPermReady] = useState(false);
  const webRef = useRef<WebView>(null);

  const requestCamera = useCallback(async () => {
    try {
      const r = await Camera.requestCameraPermissionsAsync();
      setPermReady(r.granted === true);
    } catch {
      setPermReady(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'receive') {
      setPermReady(false);
      void requestCamera();
    }
  }, [mode, requestCamera]);

  /** Ruajtje automatike në galeri (albumi "SonoLink"). */
  const saveToGallery = useCallback(async (name: string, mime: string, b64: string) => {
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        ToastAndroid.show('Galeria: leja u refuzua', ToastAndroid.LONG);
        return;
      }
      const safe = name.replace(/[^\w.\-]+/g, '_');
      const fileUri = FileSystem.cacheDirectory + 'sono-' + safe;
      await FileSystem.writeAsStringAsync(fileUri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      await MediaLibrary.createAlbumAsync('SonoLink', asset, false).catch(() => {});
      ToastAndroid.show('U ruajt automatikisht në galeri (SonoLink)', ToastAndroid.LONG);
    } catch {
      ToastAndroid.show('Ruajtja në galeri dështoi', ToastAndroid.LONG);
    }
  }, []);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      const data = ev.nativeEvent.data;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.type === 'sonolink-autosave' && typeof msg.b64 === 'string') {
          void saveToGallery(
            String(msg.name || 'foto.jpg'),
            String(msg.mime || 'image/jpeg'),
            msg.b64,
          );
        }
      } catch {
        // mesazhe të tjera të faqes — injoroji
      }
    },
    [saveToGallery],
  );

  /**
   * Zgjedhje e skedarit me picker NATIV (expo-document-picker) dhe injektim
   * te input-i `#cfg-file` i sender-it Decimen me DataTransfer — e njëjta
   * teknikë si DritaBridge.kt i projektit Drita. Kjo heq mbështetjen nga
   * file chooser-i i WebView-it (shpesh i vdekur në Android) — s'ka më
   * dead end te "Dërgo (QR)": skedari futet direkt në encoder.
   */
  const pickAndInjectFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      const f = res.assets[0];
      ToastAndroid.show('Po ngarkohet te dërguesi…', ToastAndroid.SHORT);
      const b64 = await FileSystem.readAsStringAsync(f.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const safe = f.name.replace(/[^\w.\-]+/g, '_');
      const mime = f.mimeType || 'application/octet-stream';
      const js =
        "(function(){try{" +
        "var b=atob(" + JSON.stringify(b64) + ");" +
        "var u=new Uint8Array(b.length);" +
        "for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);" +
        "var file=new File([u]," + JSON.stringify(safe) + ",{type:" + JSON.stringify(mime) + "});" +
        "var dt=new DataTransfer();dt.items.add(file);" +
        "var el=document.getElementById('cfg-file');" +
        "if(el){el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));}" +
        "}catch(e){console.error(e);}})();";
      webRef.current?.injectJavaScript(js);
      ToastAndroid.show('Skedari u dha dërguesit — QR po pulson', ToastAndroid.LONG);
    } catch {
      ToastAndroid.show('Zgjedhja e skedarit dështoi', ToastAndroid.LONG);
    }
  }, []);

  /** getUserMedia i faqes merr lejen direkt nëse app-i e ka. */
  const onPermissionRequest = useCallback((req: unknown) => {
    if (req && typeof (req as any).grant === 'function') (req as any).grant((req as any).resources);
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>TRANSFERIMI OPTIK</Text>
        <Text style={styles.subtitle}>
          Dërgo skedarë me ekran ose merr me kamerë — pa rrjet, nga drita.
        </Text>
        <View style={styles.switchRow}>
          <TouchableOpacity
            style={[styles.switchBtn, mode === 'send' && styles.switchBtnActive]}
            onPress={() => setMode('send')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="qr-code-outline"
              size={16}
              color={mode === 'send' ? '#06231F' : theme.colors.textSecondary}
            />
            <Text style={[styles.switchText, mode === 'send' && styles.switchTextActive]}>
              Dërgo (QR)
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.switchBtn, mode === 'receive' && styles.switchBtnActive]}
            onPress={() => setMode('receive')}
            activeOpacity={0.8}
          >
            <Ionicons
              name="camera-outline"
              size={16}
              color={mode === 'receive' ? '#06231F' : theme.colors.textSecondary}
            />
            <Text style={[styles.switchText, mode === 'receive' && styles.switchTextActive]}>
              Skano me Kamera
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* key={mode} rifreskon WebView-in e plotë ndërmjet modeve (faqet janë self-contained).
          Në "receive" WebView-i hapet VETËM pasi leja e kamerës të jetë pranuar —
          kështu auto-start-i i injektuar e gjen kamerën gati. */}
      {(mode === 'send' || permReady) && (
        <WebView
          ref={webRef}
          key={mode}
          style={styles.web}
          containerStyle={styles.webContainer}
          source={{
            uri:
              OPTICAL_BASE +
              (mode === 'send' ? 'decimen-sender.html' : 'decimen-receiver.html'),
          }}
          originWhitelist={['*']}
          // file:// : JS + DOM storage + qasje lokale (faqet janë offline, pa rrjet).
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          mediaPlaybackRequiresUserAction={false}
          setSupportMultipleWindows={false}
          injectedJavaScriptBeforeContentLoaded={INJECT_AUTO}
          onMessage={onMessage}
        />
      )}
      {mode === 'receive' && !permReady && (
        <View style={[styles.web, styles.permWait]}>
          <Text style={styles.permText}>Po kërkohet leja e kamerës…</Text>
        </View>
      )}

      {/* Bar natyshëm poshtë: zgjedhje skedari pa u mbështetur te file chooser
          i WebView-it (dead end i vjetër) + rruga reale P50 → telefon. */}
      <View style={styles.footer}>
        {mode === 'send' && (
          <TouchableOpacity style={styles.footBtn} onPress={() => void pickAndInjectFile()} activeOpacity={0.8}>
            <Ionicons name="document-outline" size={16} color="#06231F" />
            <Text style={styles.footBtnText}>Zgjidh skedar</Text>
          </TouchableOpacity>
        )}
        {onOpenP50Scan && (
          <TouchableOpacity style={styles.footBtnGhost} onPress={onOpenP50Scan} activeOpacity={0.8}>
            <Ionicons name="wifi-outline" size={16} color={theme.colors.primary} />
            <Text style={styles.footBtnGhostText}>Merr nga P50 (WiFi)</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 4 },
  title: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  subtitle: { color: theme.colors.textMuted, fontSize: 12 },
  switchRow: {
    flexDirection: 'row',
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: theme.radius.sm,
    padding: 4,
    marginTop: 8,
    gap: 4,
  },
  switchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: theme.radius.sm - 4,
  },
  switchBtnActive: { backgroundColor: theme.colors.primary },
  switchText: { fontSize: 13, color: theme.colors.textSecondary, fontWeight: '600' },
  switchTextActive: { color: '#06231F', fontWeight: '700' },
  web: { flex: 1 },
  webContainer: { backgroundColor: '#070a11' },
  unit: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  permWait: {
    flex: 1,
    backgroundColor: '#0b0e16',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  permText: { color: theme.colors.textMuted, fontSize: 13, textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.backgroundCard,
  },
  footBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  footBtnText: { color: '#06231F', fontWeight: '700', fontSize: 13 },
  footBtnGhost: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  footBtnGhostText: { color: theme.colors.primary, fontWeight: '700', fontSize: 13 },
});