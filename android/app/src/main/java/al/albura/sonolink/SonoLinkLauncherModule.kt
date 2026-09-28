package al.albura.sonolink

import al.albura.sonolink.drita.MeshStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent

/**
 * SonoLinkLauncher — ADDITIVE: modul RN qe hap aktivitetet optike nativ
 * (paketa .drita) me Intent eksplicit. File i ri — MainActivity/MainApplication
 * ekzistuese nuk preken (autolinking e regjistron automatikisht nese paketa
 * shtohet ne getPackages; perndryshe hapet manualisht).
 */
class SonoLinkLauncherModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName() = "SonoLinkLauncher"

    @ReactMethod
    fun openActivity(className: String, p: Promise) {
        try {
            val cls = Class.forName(className)
            val intent = Intent(reactApplicationContext, cls).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            p.resolve(true)
        } catch (e: Exception) {
            p.reject("NO_ACTIVITY", e.message, e)
        }
    }

    /**
     * ADDITIVE — ura nativ → JS per transferimin optik.
     *
     * LightScanActivity (CameraX + ZXing) depoziton çdo QR të skanuar në
     * MeshStore. Kjo metodë i zbën ato në JS, ku OpticalBridge i kalon te
     * decodeOpticalQrData + ingestOpticalFrame (LTDecoder i opticalProtocol.ts).
     *
     * Drenazhi është "read-and-clear": çdo frame kalon te JS vetëm një herë,
     * ndaj rikthimi i aktivitetit nuk e dëmton të njëjtin transfer.
     */
    @ReactMethod
    fun drainOpticalFrames(p: Promise) {
        try {
            val out = Arguments.createArray()
            for (text in MeshStore.drain()) out.pushString(text)
            p.resolve(out)
        } catch (e: Exception) {
            p.reject("DRAIN_FAILED", e.message, e)
        }
    }

    /** Sa frame i skanuar akoma nuk janë marrë nga JS (për shfaqjen e statusit). */
    @ReactMethod
    fun pendingOpticalFrameCount(p: Promise) {
        try {
            p.resolve(MeshStore.size())
        } catch (e: Exception) {
            p.reject("COUNT_FAILED", e.message, e)
        }
    }
}
