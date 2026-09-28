Plan u ekzekutua:

1. **app.json** — e gjithë bloku `ios` u hoq: pa iOS, pa Play Store, pa bundleIdentifier/iOS — shpërndarja mbetet **vetëm Android via USB** (teste te brendshme).

2. **AndroidManifest.xml** — u hiqën lejet që nuk duhen: `READ_EXTERNAL_STORAGE`, `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `WRITE_EXTERNAL_STORAGE`. U mbetën: `INTERNET` (device eshte ne rrjet lokal), WIFI perms, `CAMERA` (QR), `VIBRATE` (haptics), `NETWORK` perms.

3. **build.gradle** — `debuggableVariants = []`: tani edhe DEBUG APK-ja ka JS bundle te ngjitur brenda — **asnjehere nuk del ekran i kuq** "Could not connect to development server", pa Metro, pa adb, pa dev server. U ndërtuan të dyja variantet.

Rezultati:
- `app-debug.apk` (101 MB) — teste USB direkte
- `app-release.apk` (101 MB) — shperndarje finale via USB

Të dyja variantet ndërtuan `BUILD SUCCESSFUL in 1m 32s`.