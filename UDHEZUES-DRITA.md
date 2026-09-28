# SonoLink + Drita — udhezues build/test (Android-only, USB)

APK del ne `android/app/build/outputs/apk/debug/app-debug.apk`.

## 1. Build (Terminal 1 — lëre të punojë 2–8 min)

```powershell
cd C:\Users\roven\Desktop\sonolink-mobile\android
$env:JAVA_HOME='C:\Users\roven\.jdks\jbr-17.0.14'
.\gradlew assembleDebug --no-daemon
```

Fundi i pritur: `BUILD SUCCESSFUL`. Nese del `Unresolved reference`
per `camera/mlkit/zxing` → kontrollo bllokun ADDITIVE ne
`android/app/build.gradle` + sinkronizo Gradle ne Android Studio.

## 2. Instalim via USB (pasi build-i te dale jeshil)

```powershell
adb install -r C:\Users\roven\Desktop\sonolink-mobile\android\app\build\outputs\apk\debug\app-debug.apk
adb shell am start -n al.albura.sonolink/.MainActivity
```

## 3. Test ne pajisje reale

1. Tab `DRITA` → `Skano driten`: drejto kameren nga `QR Export` i P50
   (30cm–3m); butoni `Ruaj` ruan ne `Download/SonoLink`.
2. Tab `DRITA` → `Kap + OCR`: foto ekranit te aparatit; teksti kopjohet vete.
3. Tab `DRITA` → `SOS me blic`: shkruaj ID pacient → `Dergo`; ne erresire
   lexohet nga cdo kamere (LightCodecs 8N1 200ms + CRC16).
4. Tab `DRITA` → `Solar`: `Ndegjo sensorin`, afro blicin te sensori i drites.
5. Flow ekzistues i paprekur: `DECIMEN` (QR-stream file-a te rende),
   `Scan` (P50 QR+TCP), `Home/Album/Settings`.

## 4. Shenime teknike

- Stack i ngrirë: `compileSdk/target 34, minSdk 23, AGP 8.5.2, Gradle 8.8,
  Kotlin 1.9.24, JDK 17` (mos e ngri pa migruar Expo 51 / RN 0.74.5).
- Tekst i shkurter = LightCodecs (`AA AA + TYPE + LEN + CRC16`);
  file-a te rende = Decimen/TCP (`framing.ts` ende i pakonfirmuar — verifiko
  me `describeRawChunkForDebugging` para te dhenave reale).
- `MLKit text-recognition 16.0.1` (bundled, offline) + CameraX rrisin APK-ne
  ~101MB → ~125MB.
