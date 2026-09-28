package al.albura.sonolink.drita

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * DRITA SOS TORCH, pa QR e pa ekran: dergon tekst me pulsim blici (8N1).
 * FIX v2: unit=200ms (kalibruar per kamerat 15-30fps), frame me preamble+CRC16
 * (LightCodecs), perseritje 2x per siguri. Pranohet tekst edhe nga LightMesh.
 */
class SosTorchActivity : AppCompatActivity() {

    private lateinit var input: EditText
    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var sending = false
    private var stopReq = false
    private val unit = 200L
    private val torchBridge by lazy { al.albura.sonolink.SonoLinkBridge(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            setBackgroundColor(0xFF000000.toInt())
        }
        val title = TextView(this).apply {
            text = getString(al.albura.sonolink.R.string.sos_title)
            setTextColor(0xFFFFE082.toInt()); textSize = 18f
        }
        val hint = TextView(this).apply {
            text = getString(al.albura.sonolink.R.string.sos_hint)
            setTextColor(0xFF9FB3C8.toInt()); textSize = 13f
        }
        input = EditText(this).apply {
            this.hint = "SOS"
            setTextColor(0xFFFFFFFF.toInt())
            setHintTextColor(0xFF666666.toInt())
        }
        status = TextView(this).apply {
            text = ""; setTextColor(0xFFFFFFFF.toInt()); textSize = 14f
        }
        val btnSend = Button(this).apply {
            text = getString(al.albura.sonolink.R.string.sos_btn_send)
            setOnClickListener { send() }
        }
        val btnStop = Button(this).apply {
            text = getString(al.albura.sonolink.R.string.sos_btn_stop)
            setOnClickListener { stop() }
        }
        val scroll = ScrollView(this).apply { addView(status) }
        col.addView(title); col.addView(hint); col.addView(input)
        col.addView(btnSend); col.addView(btnStop)
        col.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(col)

        // LightMesh ridergese: tekst i gatshem nga mesh store
        val relayText = intent?.getStringExtra(EXTRA_TEXT)
        if (!relayText.isNullOrBlank()) {
            input.setText(relayText)
            send()
        }
    }

    private fun torch(on: Boolean): Boolean {
        return try { torchBridge.toggleTorch(on) } catch (_: Exception) { false }
    }

    private fun send() {
        if (sending) return
        val text = input.text.toString().ifBlank { "SOS" }
        sending = true; stopReq = false
        status.text = "Duke derguar: $text"
        Thread {
            try {
                // Frame i framuar me preamble + CRC16 (lexohet edhe nga decoderi legacy 8N1)
                val bits = LightCodecs.frameBits(LightCodecs.TYPE_TXT, text)
                torch(false)
                Thread.sleep(unit * 4)
                var round = 0
                while (round < 2 && !stopReq) {
                    var i = 0
                    while (i < bits.size && !stopReq) {
                        torch(bits[i] == 1)
                        Thread.sleep(unit)
                        i++
                    }
                    if (round == 0 && !stopReq) {
                        torch(false)
                        Thread.sleep(800)
                    }
                    round++
                }
                torch(false)
                runOnUiThread {
                    status.text = if (stopReq) "U ndal." else "U dergua (2x, CRC ok): $text"
                }
            } catch (_: Exception) {
            } finally {
                try { torch(false) } catch (_: Exception) {}
                sending = false
            }
        }.start()
    }

    private fun stop() {
        stopReq = true
        handler.post { torch(false) }
        Toast.makeText(this, "Po ndalet...", Toast.LENGTH_SHORT).show()
    }

    override fun onPause() {
        stopReq = true
        try { torch(false) } catch (_: Exception) {}
        super.onPause()
    }

    companion object {
        const val EXTRA_TEXT = "drita_sos_text"
    }
}
