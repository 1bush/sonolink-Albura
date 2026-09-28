package al.albura.sonolink

import android.app.Activity
import android.content.ContentValues
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream

/**
 * SonoLink Bridge — komunikim mes WebView (decimen-sender/receiver) dhe Android nativ.
 *
 * - saveToSonoLink: ruaj skedarë e marrta me dritë në storage të app-ës (përmes DECIMEN receiver).
 * - injectFileFromNative: ju e thirrni nga JS/iheri te decimen-sender.html; injekto skedarin nativo
 *   direkt te input-i `#cfg-file` me DataTransfer (e njëjta teknikë si DritaBridge.eu).
 * - toggleTorch / setScreenBrightness / setKeepScreenOn: optimizim ekrani kur dërguesit.
 */
class SonoLinkBridge(private val activity: Activity) {

    private var listener: SonoLinkEventListener? = null

    fun setListener(listener: SonoLinkEventListener) { this.listener = listener }

    @JavascriptInterface
    fun saveToSonoLink(fileName: String, base64Bytes: String, mimeType: String): String {
        return try {
            val bytes = android.util.Base64.decode(base64Bytes, android.util.Base64.DEFAULT)
            val sonoDir = File(activity.getExternalFilesDir(null), "SonoLink")
            sonoDir.mkdirs()
            val outFile = File(sonoDir, fileName)
            FileOutputStream(outFile).use { it.write(bytes) }
            MediaScannerConnection.scanFile(activity, arrayOf(outFile.absolutePath), arrayOf(mimeType)) { _, uri ->
                listener?.onFileSaved(uri?.toString() ?: "")
            }
            outFile.absolutePath
        } catch (e: Exception) {
            e.printStackTrace()
            listener?.onError(e.message ?: "Gabim në ruajtje")
            ""
        }
    }

    @JavascriptInterface
    fun saveToDownloads(fileName: String, base64Bytes: String, mimeType: String): String {
        return try {
            val bytes = android.util.Base64.decode(base64Bytes, android.util.Base64.DEFAULT)
            val cv = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Downloads.RELATIVE_PATH, "Download/SonoLink")
                }
            }
            val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)
            if (uri != null) {
                activity.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                listener?.onFileSaved(uri.toString())
                uri.toString()
            } else {
                listener?.onError("Nuk mund u krijohet në Downloads")
                ""
            }
        } catch (e: Exception) {
            e.printStackTrace()
            listener?.onError(e.message ?: "Gabim në Downloads")
            ""
        }
    }

    @JavascriptInterface
    fun toggleTorch(enable: Boolean): Boolean {
        return try {
            val cm = activity.getSystemService(android.content.Context.CAMERA_SERVICE) as CameraManager
            var camId: String? = null
            for (id in cm.cameraIdList) {
                val chars = cm.getCameraCharacteristics(id)
                val flashAvailable: Boolean? = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)
                if (flashAvailable == true) { camId = id; break }
            }
            if (camId != null) { cm.setTorchMode(camId, enable); true } else false
        } catch (e: Exception) { e.printStackTrace(); false }
    }

    @JavascriptInterface
    fun setScreenBrightness(enable: Boolean) {
        activity.runOnUiThread {
            val w = activity.window
            if (enable) {
                w.attributes = w.attributes.apply { screenBrightness = 1.0f }
                w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                w.attributes = w.attributes.apply { screenBrightness = android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
                w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    @JavascriptInterface
    fun setKeepScreenOn(enable: Boolean) {
        activity.runOnUiThread {
            if (enable) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @JavascriptInterface
    fun showToast(message: String) {
        activity.runOnUiThread { Toast.makeText(activity, message, Toast.LENGTH_SHORT).show() }
    }

    interface SonoLinkEventListener {
        fun onFileSaved(uri: String)
        fun onError(message: String)
    }
}