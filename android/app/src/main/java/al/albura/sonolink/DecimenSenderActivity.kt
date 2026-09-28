package al.albura.sonolink

import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * DECIMEN Sender - "DÃ«rgo (QR)" NATIV (pa dead end).
 *
 * Problemo i vjetÃ«r: decimen-sender.html ngarkoja te react-native-webview dhe
 * input-i `<input type="file" id="cfg-file">` nuk hapet nÃ« Android -> DEAD END.
 *
 * Zgjidhja: ngarkojmÃ« tÃ« jÃ«rthen e decimen-sender.html natyr te WebView e
 * aplikacionit, por skedari zgjedhet me PICKER NATIV Android (GetContent) dhe
 * injektohet direkt te `#cfg-file` me DataTransfer (e njÃ«jta teknikÃ« si Drita).
 */
class DecimenSenderActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var pickButton: Button
    private lateinit var b64Input: TextView
    private val decodeExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private val filePickerLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            if (uri != null) injectNativeFile(uri)
        }
override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF070a11.toInt()) }
        webView = WebView(this)
        webView.id = View.generateViewId()
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        val s: WebSettings = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.loadWithOverviewMode = true
        s.useWideViewPort = true

        webView.addJavascriptInterface(SonoLinkBridge(this), "SonoLink")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(
                    "(function(){try{" +
                        "window.SonoLink={isNative:true,mode:'sender'};" +
                        "var f=document.getElementById('cfg-fps');if(f){f.value='30';f.dispatchEvent(new Event('change',{bubbles:true}));}" +
                        "var b=document.getElementById('cfg-bytes');if(b){[].slice.call(b.options).length>0&&(b.value=b.options[b.options.length-1].value,b.dispatchEvent(new Event('change',{bubbles:true})));}" +
                        "var e=document.getElementById('cfg-ecc');if(e){e.value='M';e.dispatchEvent(new Event('change',{bubbles:true}));}" +
                        "var g=document.getElementById('cfg-grid');if(g){g.value='2';g.dispatchEvent(new Event('change',{bubbles:true}));}" +
                        "var sz=document.getElementById('cfg-size');if(sz){sz.value=sz.max||'1200';sz.dispatchEvent(new Event('input',{bubbles:true}));sz.dispatchEvent(new Event('change',{bubbles:true}));}" +
                        "}catch(e){}})();",
                    null
                )
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest?) {
                if (request != null) { request.grant(request.resources) }
            }
        }

        pickButton = Button(this).apply {
            text = "Zgjidh skedar (natyr)"
            setOnClickListener { filePickerLauncher.launch("image/*") }
        }
        b64Input = TextView(this).apply {
            text = "Skedar i zgjedhur: —"
            setTextColor(0xFFFFFFFF.toInt()); textSize = 12f
            setPadding(8, 8, 8, 8)
        }

        root.addView(webView, android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT
        ))
        root.addView(b64Input, android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
        ))
        val pickLp = android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL
        ).apply { setMargins(8, 8, 8, 8) }
        root.addView(pickButton, pickLp)
        setContentView(root)

        webView.loadUrl("https://appassets.androidplatform.net/assets/optical/decimen-sender.html")
    }
/** Lexe skedarin nga picker natyr (GetContent) dhe injekto te decimen-sender.html. */
    private fun injectNativeFile(uri: Uri) {
        decodeExecutor.execute {
            try {
                var name = queryName(uri)
                if (name.isNullOrEmpty() || name == "sono") name = "skedar" + System.currentTimeMillis()
                val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: byteArrayOf()
                val safe = name.replace(Regex("[^\\w.\\-]+"), "_")
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

                runOnUiThread {
                    val js =
                        "(function(){try{" +
                            "var b=atob('" + b64 + "');" +
                            "var u=new Uint8Array(b.length);" +
                            "for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);" +
                            "var file=new File([u],'" + safe + "',{type:'" + mime + "'});" +
                            "var dt=new DataTransfer();dt.items.add(file);" +
                            "var el=document.getElementById('cfg-file');" +
                            "if(el){el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));}" +
                            "}catch(e){console.error(e);}})();"
                    webView.evaluateJavascript(js, null)
                    b64Input.text = "Skedar i zgjedhur: " + safe + " (" + bytes.size + " B)"
                    Toast.makeText(this, "QR po pulson — dërguesi nisë", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                e.printStackTrace()
                runOnUiThread {
                    b64Input.text = "Gabim në leximin e skedarit"
                    Toast.makeText(this, "Gabim: " + (e.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }
    }

private fun queryName(uri: Uri): String {
        var name: String? = null
        if (uri.scheme == "content") {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) name = c.getString(i)
            }
        }
        return name ?: "sono"
    }

    override fun onDestroy() {
        try { decodeExecutor.shutdown() } catch (_: Exception) {}
        try { webView.destroy() } catch (_: Exception) {}
        super.onDestroy()
    }
}