package al.albura.sonolink.drita

/**
 * SonoLink LightCodecs — kopje additive nga Drita (pa ndryshuar kodin ekzistues).
 * Protokolli i perbashket per kanalin e blicit/ekranit (mesazhe te shkurtra tekst):
 * Frame: 0xAA 0xAA | TYPE | LEN(2 BE) | PAYLOAD | CRC16-CCITT(2 BE)
 * Trasporti: cdo byte dergohet 8N1 (start=0, 8 bit LSB-first, stop=11).
 * Per file-a te rende (imazhe DICOM) perdoret Decimen/Optical; ky modul eshte
 * vetem per tekst te shkurter (ID pacient, shifra) me CRC.
 */
object LightCodecs {
    const val TYPE_TXT = 0x01
    const val TYPE_ACK = 0x02
    const val PREAMBLE = 0xAA

    fun crc16(data: ByteArray): Int {
        var crc = 0xFFFF
        for (b in data) {
            crc = crc xor ((b.toInt() and 0xFF) shl 8)
            repeat(8) {
                crc = if (crc and 0x8000 != 0) (crc shl 1) xor 0x1021 else crc shl 1
                crc = crc and 0xFFFF
            }
        }
        return crc
    }

    fun buildFrame(type: Int, payload: ByteArray): ByteArray {
        val out = ArrayList<Byte>(payload.size + 9)
        out.add(PREAMBLE.toByte()); out.add(PREAMBLE.toByte())
        out.add(type.toByte())
        out.add(((payload.size shr 8) and 0xFF).toByte())
        out.add((payload.size and 0xFF).toByte())
        for (b in payload) out.add(b)
        val hdr = byteArrayOf(
            type.toByte(),
            ((payload.size shr 8) and 0xFF).toByte(),
            (payload.size and 0xFF).toByte()
        )
        val c = crc16(hdr + payload)
        out.add(((c shr 8) and 0xFF).toByte())
        out.add((c and 0xFF).toByte())
        return out.toByteArray()
    }

    /** Frame -> bit-stream 8N1 (LSB-first). */
    fun frameBits(type: Int, text: String): List<Int> {
        val bits = mutableListOf<Int>()
        for (b in buildFrame(type, text.toByteArray(Charsets.UTF_8))) {
            var v = b.toInt() and 0xFF
            bits.add(0)
            repeat(8) { bits.add(v and 1); v = v shr 1 }
            bits.add(1); bits.add(1)
        }
        return bits
    }

    /**
     * Decoder: ushqehet me byte-te e dekoduar nga 8N1 dhe nxjerr
     * mesazhe te framuar me CRC te vlefshem.
     */
    class FramedDecoder(private val onMessage: (type: Int, text: String) -> Unit) {
        private val buf = ArrayList<Byte>()

        @Synchronized
        fun feed(b: Int) {
            buf.add((b and 0xFF).toByte())
            if (buf.size > 4096) repeat(1024) { buf.removeAt(0) }
            scan()
        }

        @Synchronized
        private fun scan() {
            while (true) {
                var p = -1
                for (i in 0 until buf.size - 1) {
                    if (buf[i] == PREAMBLE.toByte() && buf[i + 1] == PREAMBLE.toByte()) { p = i; break }
                }
                if (p < 0 || buf.size - p < 8) return
                if (p > 0) repeat(p) { buf.removeAt(0) }
                val type = buf[2].toInt() and 0xFF
                val len = ((buf[3].toInt() and 0xFF) shl 8) or (buf[4].toInt() and 0xFF)
                if (len > 2048) { buf.removeAt(0); continue }
                if (buf.size < 5 + len + 2) return
                val payload = ByteArray(len)
                for (i in 0 until len) payload[i] = buf[5 + i]
                val crcH = buf[5 + len].toInt() and 0xFF
                val crcL = buf[6 + len].toInt() and 0xFF
                val hdr = byteArrayOf(type.toByte(), ((len shr 8) and 0xFF).toByte(), (len and 0xFF).toByte())
                val expect = crc16(hdr + payload)
                if (((expect shr 8) and 0xFF) == crcH && (expect and 0xFF) == crcL) {
                    repeat(5 + len + 2) { buf.removeAt(0) }
                    onMessage(type, String(payload, Charsets.UTF_8))
                } else {
                    buf.removeAt(0)
                }
            }
        }
    }

    /** PulseNet: shifra 0-9 -> frekuenca 2..11 Hz. */
    fun pulseCharToFreq(c: Char): Int =
        if (c in '0'..'9') 2 + (c - '0') else 0

    fun pulseFreqToChar(f: Float): Char? {
        val k = Math.round(f)
        return if (k in 2..11) ('0' + (k - 2)) else null
    }

    /** ID i shkurter 8-hex per mesh (sha-256 i permbajtjes). */
    fun shortId(text: String): String {
        val d = java.security.MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder()
        for (i in 0 until 4) sb.append("%02x".format(d[i]))
        return sb.toString()
    }
}
