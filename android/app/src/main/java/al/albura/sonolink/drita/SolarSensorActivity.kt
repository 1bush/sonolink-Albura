package al.albura.sonolink.drita

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.app.Activity

/**
 * DRITA SolarSensor — "derges nga ajri": lexon te dhena nga SENSORI I NDRICIMIT
 * (TYPE_LIGHT), pa kamera, pa leje. Blici i telefonit dergues (SosTorch)
 * pulson 8N1 me frame LightCodecs; sensori mat lux me 50-200Hz dhe dekodon.
 *
 * FIX v2 (anti-crash): extends android.app.Activity (jo AppCompatActivity) qe
 * te mos varet nga tema AppCompat e manifestit — shkaku klasik i crash-it
 * "You need to use a Theme.AppCompat theme". Plus try/catch mbrohtes ne onCreate,
 * sensor i ri-regjistruar cdo hapje (sensorManager ruhet) dhe UI update i kursyer.
 */
class SolarSensorActivity : Activity() {

    private lateinit var luxText: TextView
    private lateinit var msgText: TextView
    private lateinit var bitsText: TextView
    private var sensorManager: SensorManager? = null
    private var listening = false

    private val avgWindow = FloatArray(16)
    private var avgIdx = 0
    private var avgFilled = 0
    private var lastLevel = false
    private var levelStartMs = 0L
    private val bitBuf = StringBuilder()
    private val framed = LightCodecs.FramedDecoder { type, text ->
        runOnUiThread { msgText.append("\n[MSG$type ok] $text") }
    }
    private val unit = 200L

    private val sensorListener = object : SensorEventListener {
        private var lastUiMs = 0L

        override fun onSensorChanged(e: SensorEvent) {
            try {
                val lux = e.values.firstOrNull() ?: return
                val now = System.currentTimeMillis()
                if (now - lastUiMs > 100) {
                    lastUiMs = now
                    runOnUiThread { try { luxText.text = "Lux: %.1f".format(lux) } catch (_: Exception) {} }
                }
                avgWindow[avgIdx] = lux
                avgIdx = (avgIdx + 1) % avgWindow.size
                if (avgFilled < avgWindow.size) avgFilled++
                var avg = 0f
                for (i in 0 until avgFilled) avg += avgWindow[i]
                avg /= avgFilled
                track(lux > avg * 1.2f + 2f, now)
            } catch (_: Exception) {}
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            buildUi()
        } catch (e: Exception) {
            // Asnjehere mos crash-o aplikacionin: errori shfaqet si tekst.
            val tv = TextView(this).apply {
                text = "Solar error: ${e.message}"
                setTextColor(0xFFFF5252.toInt()); textSize = 14f
                setPadding(32, 64, 32, 32)
            }
            setContentView(tv)
        }
    }

    private fun buildUi() {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            setBackgroundColor(0xFF000000.toInt())
        }
        val title = TextView(this).apply {
            text = "☀ DRITA Solar — Sensori i drites (pa kamera)"
            setTextColor(0xFFFFE082.toInt()); textSize = 18f
        }
        val hint = TextView(this).apply {
            text = "Drejto blicin e derguesit (SOS) prane sensorit te drites. " +
                "Sensori i lexon pulseve pa kamera dhe i dekodon me CRC."
            setTextColor(0xFF9FB3C8.toInt()); textSize = 13f
        }
        luxText = TextView(this).apply {
            text = "Lux: --"; setTextColor(0xFF1DE9B6.toInt()); textSize = 30f
        }
        bitsText = TextView(this).apply {
            text = ""; setTextColor(0xFF4FC3F7.toInt()); textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
        }
        msgText = TextView(this).apply {
            text = "Asnje mesazh."; setTextColor(0xFFFFFFFF.toInt()); textSize = 15f
        }
        val btnToggle = Button(this).apply {
            text = "▶ Ndegjo sensorin"
            setOnClickListener {
                listening = !listening
                if (listening) startSensor() else stopSensor()
                text = if (listening) "⏹ Ndale sensorin" else "▶ Ndegjo sensorin"
            }
        }
        val btnClear = Button(this).apply {
            text = "🧹 Pastro"
            setOnClickListener { msgText.text = "Asnje mesazh."; bitBuf.clear(); bitsText.text = "" }
        }
        val scroll = ScrollView(this).apply { addView(msgText); addView(bitsText) }
        col.addView(title); col.addView(hint); col.addView(luxText)
        col.addView(btnToggle); col.addView(btnClear)
        col.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(col)
    }

    private fun startSensor() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val light = sensorManager?.getDefaultSensor(Sensor.TYPE_LIGHT)
        if (light == null) {
            msgText.append("\n[!] Ky telefon ska sensor drite.")
            return
        }
        sensorManager?.registerListener(sensorListener, light, SensorManager.SENSOR_DELAY_FASTEST)
    }

    private fun stopSensor() {
        try { sensorManager?.unregisterListener(sensorListener) } catch (_: Exception) {}
    }

    private fun track(level: Boolean, now: Long) {
        if (level != lastLevel) {
            if (levelStartMs > 0L) {
                val dur = now - levelStartMs
                if (dur > 40) {
                    // FIX: kalibrim me njesi 200ms — perputhet me SosTorch
                    val units = ((dur + unit / 2) / unit).toInt().coerceIn(1, 24)
                    val bit = if (lastLevel) '1' else '0'
                    repeat(units) { bitBuf.append(bit) }
                    if (bitBuf.length > 400) bitBuf.delete(0, bitBuf.length - 400)
                    runOnUiThread { bitsText.text = "Bits: ...$bitBuf" }
                    decodeBits()
                }
            }
            lastLevel = level
            levelStartMs = now
        }
    }

    /** Dekodim 8N1 (start=0, 8 bit LSB-first, stop=11). */
    private fun decodeBits() {
        while (bitBuf.length >= 11) {
            val s = bitBuf.indexOf("0")
            if (s < 0 || bitBuf.length - s < 11) break
            if (s > 0) bitBuf.delete(0, s)
            if (bitBuf.length < 11) break
            if (bitBuf[9] == '1' && bitBuf[10] == '1') {
                var v = 0
                for (i in 0 until 8) if (bitBuf[1 + i] == '1') v = v or (1 shl i)
                framed.feed(v)
                bitBuf.delete(0, 11)
            } else {
                bitBuf.deleteCharAt(0)
            }
        }
    }

    override fun onPause() {
        listening = false
        stopSensor()
        super.onPause()
    }
}
