package al.albura.sonolink.drita

/**
 * OpticalState — state për receptionin e frame-ve optik nga native.
 * Mbajti i te dhenave te dekoduar nga skanimit optik (CameraX + ZXing).
 * Perdoret si kontejner i perbashket per sekwencat e frame-ve gjatë skanimit
 * me kamera natyrale.
 */
class OpticalState {
    var lastSeq: Int = 0
    var lastFrameMs: Long = 0L
    var frameCount: Int = 0
    val buffer = StringBuilder()
}