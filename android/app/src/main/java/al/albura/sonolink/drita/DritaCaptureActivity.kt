package al.albura.sonolink.drita

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import al.albura.sonolink.R
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** DRITA KAP ME DRITE, pa QR: kap foto + OCR offline + kopjon vete. */
class DritaCaptureActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var statusText: TextView
    private lateinit var ocrText: TextView
    private var imageCapture: ImageCapture? = null
    private var lastPhoto: File? = null
    private var lastOcr = ""
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        previewView = PreviewView(this)
        statusText = TextView(this).apply {
            text = getString(R.string.capture_hint)
            setTextColor(0xFFFFE082.toInt()); textSize = 14f
            setPadding(24, 24, 24, 8)
        }
        ocrText = TextView(this).apply {
            text = "-"; setTextColor(0xFFFFFFFF.toInt()); textSize = 14f
            setPadding(24, 8, 24, 8)
        }
        val btnShoot = Button(this).apply {
            text = getString(R.string.capture_btn_shoot)
            setOnClickListener { shoot() }
        }
        val btnCopy = Button(this).apply {
            text = getString(R.string.capture_btn_copy)
            setOnClickListener { copyOcr() }
        }
        val btnSave = Button(this).apply {
            text = getString(R.string.capture_btn_save)
            setOnClickListener { savePhoto() }
        }
        val scroll = ScrollView(this).apply { addView(ocrText) }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(statusText)
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
            val row = LinearLayout(this@DritaCaptureActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(0, -2, 1f)
                addView(btnShoot, lp); addView(btnCopy, lp); addView(btnSave, lp)
            }
            addView(row)
        }
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        root.addView(col, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED) startCamera()
        else ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 43)
    }

    override fun onRequestPermissionsResult(c: Int, p: Array<String>, r: IntArray) {
        super.onRequestPermissionsResult(c, p, r)
        if (c == 43 && r.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else { Toast.makeText(this, "Duhet kamera", Toast.LENGTH_LONG).show(); finish() }
    }

    private fun startCamera() {
        val f = ProcessCameraProvider.getInstance(this)
        f.addListener({
            val provider = f.get()
            val preview = Preview.Builder().build()
            preview.setSurfaceProvider(previewView.surfaceProvider)
            imageCapture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build()
            try {
                provider.unbindAll()
                provider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture)
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Kamera: " + e.message, Toast.LENGTH_LONG).show()
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun shoot() {
        val cap = imageCapture ?: return
        if (busy) return
        busy = true
        statusText.text = "Duke kapur..."
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val out = File(getExternalFilesDir(null), "sonolink-kap-$stamp.jpg")
        val opts = ImageCapture.OutputFileOptions.Builder(out).build()
        cap.takePicture(opts, ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onError(e: ImageCaptureException) {
                    busy = false
                    runOnUiThread { statusText.text = "KAP deshtoi: " + e.message }
                }
                override fun onImageSaved(o: ImageCapture.OutputFileResults) {
                    lastPhoto = out
                    runOnUiThread { statusText.text = "U kap! Duke lexuar..." }
                    runOcr(out)
                }
            })
    }

    private fun runOcr(file: File) {
        try {
            val img = InputImage.fromFilePath(this, android.net.Uri.fromFile(file))
            val rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
            rec.process(img)
                .addOnSuccessListener { v ->
                    busy = false
                    lastOcr = v.text ?: ""
                    runOnUiThread {
                        ocrText.text = if (lastOcr.isBlank()) "(s'ka tekst)" else lastOcr
                        statusText.text = "Gati - teksti u kopjua; fotoja ruhet me Ruaj."
                    }
                    copyOcr(silent = true)
                }
                .addOnFailureListener { e ->
                    busy = false
                    runOnUiThread { statusText.text = "OCR deshtoi: " + e.message }
                }
        } catch (e: Exception) {
            busy = false
            statusText.text = "OCR gabim: " + e.message
        }
    }

    private fun copyOcr(silent: Boolean = false) {
        if (lastOcr.isBlank()) {
            if (!silent) Toast.makeText(this, "S'ka tekst", Toast.LENGTH_SHORT).show()
            return
        }
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("SonoLink", lastOcr))
        if (!silent) Toast.makeText(this, "U kopjua!", Toast.LENGTH_SHORT).show()
    }

    private fun savePhoto() {
        val f = lastPhoto
        if (f == null || !f.exists()) {
            Toast.makeText(this, "Kap nje foto me pare", Toast.LENGTH_LONG).show()
            return
        }
        try {
            val bytes = f.readBytes()
            val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            val uri = al.albura.sonolink.SonoLinkBridge(this).saveToDownloads(f.name, b64, "image/jpeg")
            Toast.makeText(this, "U ruajt: $uri", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Ruajtja: " + e.message, Toast.LENGTH_LONG).show()
        }
    }
}
