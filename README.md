# SonoLink v3.0 (Android/Expo)

Aplikacion Android (Expo/React Native + TypeScript) për Klinika Albura, që lidhet
direkt me aparatin **SonoScape P50 Elite** duke skanuar QR-in e ekranit
"QR Export" të aparatit dhe merr imazhet/cine/raportet nëpërmjet një lidhjeje
TCP direkte (pa DICOM, pa PC ndërmjetës).

## Si të nisësh

```bash
npm install
npx expo start
```

Skano me Expo Go ose bëj build (`npx expo prebuild` + Android Studio / EAS) —
`react-native-tcp-socket` kërkon build native, **nuk funksionon në Expo Go**
as në web preview. Për zhvillim real duhet dev-client:

```bash
npx expo install expo-dev-client
npx expo prebuild
npx expo run:android
```

## Struktura

```
App.tsx                          — pika hyrëse, tabs Home/Album/Settings
src/
  protocol/sonoDropProtocol.ts   — parse/build QR TLV + heartbeat + file-ack
  services/
    TcpConnectionService.ts      — lidhja reale TCP (jo simulim si prototipi HTML)
    framing.ts                   — ⚠️ parsimi i skedarëve — SHIH "E PAKONFIRMUAR" më poshtë
    database.ts                  — SQLite lokale, skemë = us_album.db origjinale
    fileStorage.ts               — ruajtja e skedarëve në disk (expo-file-system)
    DicomImage.ts                — dekodues DICOM → RGB → PNG (8/16-bit, RLE, multi-frame)
    fileKinds.ts                 — identifikon formatin nga bajtët, jo nga emri i skedarit
    gallerySaver.ts              — vendos JPG/BMP/MP4 në galeri, DICOM si PNG
    OrthancService.ts            — klient optional Orthanc/DICOMweb
  screens/                       — HomeScreen, PairingScreen, AlbumScreen, SettingsScreen
                               —   plus DritaExtrasScreen dhe OpticalScreen
  components/BottomTabBar.tsx
  theme/index.ts
scripts/
  test-protocol.mjs              — round-trip QR + kontrolle mbi payload-in e P50
  dicom-image-test.cjs           — dekoduesi DICOM dhe enkoduesi PNG
  file-kinds-test.cjs            — identifikimi i formatit nga bajtët
  dicom-viewer-test.cjs          — rasterizuesi DICOM → BMP
  ingest-recovery-test.cjs       — rimëkëmbim pas gabimi/heartbeat-it
  optical-bridge-test.cjs        — ura optike Drita → LTDecoder
```

Të gjitha testet njëherësh: `npm test`.

## Çfarë është KONFIRMUAR (100% e sigurt)

- Formati i QR-it (`msgType 9000`, `tlvCount 6`, tipe `9001-9006` për
  SSID/password/enkriptim/host/port/patientId) — verifikuar drejtpërdrejt kundër
  ekranit "QR Export" të P50 Elite (imazhi i marrë) dhe kundër `sonoDropProtocol.ts`
  origjinal.
- Skema e bazës lokale (`studyinfo`, `sopinfo`) — kopjuar nga `us_album.db` i
  vërtetë i aplikacionit origjinal USAlbum.

## Çfarë ËSHTË E PAKONFIRMUAR ⚠️

**`src/services/framing.ts`** — mënyra se si aparati "paketon" bajtet e çdo
skedari (imazh/cine/raport) pas heartbeat-it **nuk është dokumentuar askund**
në materialin që kemi. Prototipi HTML i mëparshëm e kishte këtë hap plotësisht
të simuluar (skedarë "mock", jo transferim real).

Framing-u aktual në kod është një supozim i arsyeshëm (tip 4-bajtësh + gjatësi
emri 8-shifra + emër + gjatësi payload 12-shifra + bajtet e skedarit), i
zgjedhur vetëm sepse mund të mbajë skedarë binarë të mëdhenj (gjë që formati
4-shifror i QR-it nuk mund ta bëjë). **Nuk duhet besuar me të dhëna reale
pacientësh** pa e verifikuar më parë.

### Si ta verifikosh/rregullosh:

1. Lidh telefonin dhe P50 Elite në të njëjtin WiFi (si te hapat 34-38 të
   manualit DICOM, por pa pasur nevojë për ONIS/DICOM — vetëm IP+WiFi).
2. Skano QR-in nga ekrani "QR Export" i aparatit me këtë app.
3. Shto përkohësisht një log që ruan çdo `chunk` të papërpunuar (para
   `frameReader.push(buf)` te `TcpConnectionService.handleIncomingBytes`) —
   funksioni `describeRawChunkForDebugging` në `framing.ts` është pikërisht
   për këtë.
4. Bëj një eksport real nga aparati (zgjidh imazhe → OK, si te imazhi i parë
   që solle) dhe shiko bajtet reale që vijnë.
5. Përshtat `FileFrameReader` në `framing.ts` sipas asaj çfarë sheh — pjesa
   tjetër e app-it (DB, ruajtja e skedarëve, UI) s'ka nevojë të ndryshojë.

## Orthanc / DICOMweb mode

SonoLink now includes an optional Orthanc client for a clinic gateway. Configure
the Orthanc base URL and token in Settings, then test the connection. The client
can list studies and series and fetch a preview or DICOM instance. The direct
SonoDrop QR/TCP path remains available as a fallback. The QR/TCP file framing is
still explicitly unverified and must be tested with synthetic studies before
real patient data is used.

The safe transfer order is:

```text
Orthanc/DICOMweb → SonoDrop TCP → optical QR transfer
```

The app must report a failed source and only mark a transfer complete after real
bytes are received. Orthanc should be deployed behind HTTPS/authentication on a
clinic network; do not expose it directly to the public Internet.

## Rruga alternative (jo e implementuar këtu)

Manuali `DIcom_check_guide1.pdf` tregon një rrugë të dytë, plotësisht të
ndryshme: P50 Elite si DICOM Storage SCP duke dërguar drejt e te një server
DICOM (Orthanc/ONIS/etj.), pa QR fare. Kjo aplikacion **nuk e implementon**
këtë rrugë — nëse duhet edhe kjo si opsion (p.sh. për rastet kur QR/WiFi-i
direkt nuk funksionon në rrjetin e klinikës), do të duhej një shërbim shtesë
DICOM Storage SCP brenda app-it (më i komplikuar, ka librari si `dcmjs` që
mund të përdoren, por s'ka native binding gati për React Native).
