package al.albura.sonolink.drita

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * DRITA LightScan - "gjithcka me driten".
 * Skanon me kamere NATIV (CameraX + ZXing):
 * TV / LED screen / monitor / projektor / tablet / cdo QR ne ekran.
 * Drejto kameren nga drita -> QR lexohet -> butoni Ruaj e ruan ne Downloads/Drita.
 */
class LightScanActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var statusText: TextView
    private lateinit var resultText: TextView
    private lateinit var saveButton: Button
    private lateinit var clearButton: Button

    private val reader = MultiFormatReader()
    private val executor = Executors.newSingleThreadExecutor()
    private var lastText = ""
    private var framesOk = 0
    private var framesTotal = 0
    private var lastDecodeMs = 0L
    private val collected = StringBuilder()
    private val seenTexts = mutableSetOf<String>()
    private var torchOn = false
    // 📦 State për receptionin e frame-ve optik nga native
    private var opticalState = OpticalState()
    private var onFrameCallback: ((bytes: ByteArray, seq: Int) -> Unit)? = null
    private val scanBridge by lazy { al.albura.sonolink.SonoLinkBridge(this) }  // bridge për dekodim

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        previewView = PreviewView(this)
        statusText = TextView(this).apply {
            text = "Drejto kameren nga TV / LED / drita..."
            setTextColor(0xFFFFE082.toInt()); textSize = 15f
            setPadding(24, 24, 24, 8)
        }
        resultText = TextView(this).apply {
            text = "Asnje QR ende."
            setTextColor(0xFFFFFFFF.toInt()); textSize = 13f
            setPadding(24, 8, 24, 8)
        }
        saveButton = Button(this).apply {
            text = "Ruaj"
            setOnClickListener { saveCollected() }
        }
        clearButton = Button(this).apply {
            text = "Pastro"
            setOnClickListener {
                collected.clear(); seenTexts.clear(); resultText.text = "Asnje QR ende."
                Toast.makeText(this@LightScanActivity, "U pastrua", Toast.LENGTH_SHORT).show()
            }
        }
        val torchButton = Button(this).apply {
            text = "🔦 HazeCast — Skano me flash"
            setOnClickListener {
                torchOn = !torchOn
                try { scanBridge.toggleTorch(torchOn) } catch (_: Exception) {}
                text = if (torchOn) "🔦 Flash ON (HazeCast aktiv)" else "🔦 HazeCast — Skano me flash"
            }
        }
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(statusText)
            addView(resultText)
            addView(torchButton)
            val row = LinearLayout(this@LightScanActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(saveButton, lp); addView(clearButton, lp)
            }
            addView(row)
        }
        root.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        root.addView(overlay, FrameLayout.LayoutParams(-1, -2))
        setContentView(root)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 42)
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (code == 42 && res.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else { Toast.makeText(this, "Duhet leja e kameres", Toast.LENGTH_LONG).show(); finish() }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { proxy -> analyze(proxy) }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Kamera nuk u hap: " + e.message, Toast.LENGTH_LONG).show()
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }
    private fun analyze(proxy: ImageProxy) {
        try {
            val now = System.currentTimeMillis()
            if (now - lastDecodeMs < 150) return
            lastDecodeMs = now
            framesTotal++
            val bmp = proxyToBitmap(proxy) ?: return
            val w = bmp.width; val h = bmp.height
            val cw = (w * 0.8).toInt(); val ch = (h * 0.8).toInt()
            val cropped = Bitmap.createBitmap(bmp, (w - cw) / 2, (h - ch) / 2, cw, ch)
            val small = Bitmap.createScaledBitmap(cropped, 640, (640f * ch / cw).toInt(), false)
            val pixels = IntArray(small.width * small.height)
            small.getPixels(pixels, 0, small.width, 0, 0, small.width, small.height)
            val src = RGBLuminanceSource(small.width, small.height, pixels)
            val bin = BinaryBitmap(HybridBinarizer(src))
            try {
                val res = reader.decode(bin)
                val t = res.text ?: return
                framesOk++
                if (t != lastText) {
                    lastText = t
                    if (!seenTexts.contains(t)) {
                        seenTexts.add(t)
                        if (collected.isNotEmpty()) collected.append('\n')
                        collected.append(t)
                        // FIX/IDE: ushqejte Lumen Mesh — cdo QR i skanuar kalon ne mesh store
                        MeshStore.add(t)
                    }
                    runOnUiThread {
                        statusText.text = "QR u lexua (" + framesOk + "/" + framesTotal + ") - vazhdo..."
                        val pv = if (t.length > 220) t.take(220) + "..." else t
                        resultText.text = "Fundit: " + pv + "\nTotali: " + collected.length + " shenja"
                    }
                } else {
                    runOnUiThread {
                        statusText.text = "Duke lexuar driten... (" + framesOk + "/" + framesTotal + " QR ok)"
                    }
                }
            } catch (_: NotFoundException) {
                runOnUiThread {
                    if (framesTotal % 10 == 0)
                        statusText.text = "Drejto kameren nga TV / LED / drita... (" + framesTotal + " frame)"
                }
            }
            try { bmp.recycle(); cropped.recycle(); small.recycle() } catch (_: Exception) {}
        } catch (_: Exception) {
        } finally {
            try { proxy.close() } catch (_: Exception) {}
        }
    }

    private fun proxyToBitmap(proxy: ImageProxy): Bitmap? {
        return try {
            if (proxy.format == ImageFormat.YUV_420_888) {
                val y = proxy.planes[0].buffer
                val u = proxy.planes[1].buffer
                val v = proxy.planes[2].buffer
                val ySize = y.remaining(); val uSize = u.remaining(); val vSize = v.remaining()
                val nv21 = ByteArray(ySize + uSize + vSize)
                y.get(nv21, 0, ySize)
                v.get(nv21, ySize, vSize)
                u.get(nv21, ySize + vSize, uSize)
                val yuv = YuvImage(nv21, ImageFormat.NV21, proxy.width, proxy.height, null)
                val out = ByteArrayOutputStream()
                yuv.compressToJpeg(Rect(0, 0, proxy.width, proxy.height), 80, out)
                val bytes = out.toByteArray()
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } else null
        } catch (_: Exception) { null }
    }

    private fun saveCollected() {
        val text = collected.toString()
        if (text.isEmpty()) {
            Toast.makeText(this, "Ska asgje per te ruajtur - skano driten me pare", Toast.LENGTH_LONG).show()
            return
        }
        try {
            val bridge = al.albura.sonolink.SonoLinkBridge(this)
            val b64 = android.util.Base64.encodeToString(text.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            val name = "sonolink-lightscan-" + System.currentTimeMillis() + ".txt"
            val uri = bridge.saveToDownloads(name, b64, "text/plain")
            Toast.makeText(this, "U ruajt: " + uri, Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Ruajtja deshtoi: " + e.message, Toast.LENGTH_LONG).show()
        }
    }

    override fun onPause() {
        // FIX: mos lejo fener te mbeten ON pas daljes (orphan torch)
        if (torchOn) { torchOn = false; try { scanBridge.toggleTorch(false) } catch (_: Exception) {} }
        super.onPause()
    }

    override fun onDestroy() {
        try { executor.shutdown() } catch (_: Exception) {}
        super.onDestroy()
    }
}
