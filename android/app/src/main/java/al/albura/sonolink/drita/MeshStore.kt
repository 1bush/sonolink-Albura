package al.albura.sonolink.drita

/** SonoLink MeshStore — bufer i perbashket QR-esh te skanuar (kopje additive nga Drita). */
object MeshStore {
    private val scanned = mutableListOf<String>()

    @Synchronized
    fun add(t: String) {
        if (t.isNotBlank()) scanned.add(t)
    }

    @Synchronized
    fun drain(): List<String> {
        val copy = scanned.toList()
        scanned.clear()
        return copy
    }

    @Synchronized
    fun size(): Int = scanned.size
}
