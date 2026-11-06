package dev.ravenry.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The spike (debug only): can the phone board host an MCP App in the
 * double-iframe sandbox on an Android WebView? The page is
 * assets/spike/host.html at the board's origin; the outer frame comes from
 * another origin (sandbox.ravenry.test, served here); the app is a srcdoc
 * frame with sandbox="allow-scripts" and a CSP. The shell's two ways of
 * reaching native code are both installed: ravenryShell, the way the board
 * uses (addWebMessageListener, its origin only), and an
 * addJavascriptInterface object, the way it never uses, to see where each
 * one reaches.
 */
class SpikeActivity : Activity() {
    lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        results = null; hubRequests.clear(); topNavigations.clear(); shellMessages.clear()
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.javaScriptCanOpenWindowsAutomatically = true
        web.settings.setSupportMultipleWindows(false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "ravenryShell", setOf(MainActivity.ORIGIN)) { _, m, origin, main, _ ->
                shellMessages += "${origin} main=$main ${m.data}"
            }
        }
        web.addJavascriptInterface(object {
            @JavascriptInterface fun secret(): String = "native reached"
        }, "leaky")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                val path = u.path ?: ""
                if (u.host == MainActivity.HOST && path.startsWith("/phone/hub/")) {
                    // The board's own rule (MainActivity, HubGate).
                    val ok = request.method == "GET" && HubGate.allowed(request.requestHeaders)
                    hubRequests += "${request.requestHeaders["Origin"] ?: request.requestHeaders["origin"] ?: "no origin"} ${request.requestHeaders["Referer"] ?: "no referer"} ${if (ok) "served" else "refused"}"
                    if (!ok) return HubGate.refused()
                    return WebResourceResponse("application/json", "utf-8", 200, "OK", emptyMap(), ByteArrayInputStream("{\"secret\":\"hub data\"}".toByteArray()))
                }
                val host = u.host
                if ((host == MainActivity.HOST || host == SANDBOX) && path.startsWith("/spike/")) {
                    val type = if (path.endsWith(".html")) "text/html" else "text/plain"
                    return runCatching { WebResourceResponse(type, "utf-8", assets.open(path.removePrefix("/"))) }.getOrNull()
                }
                return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url.toString()
                if (request.isForMainFrame && !u.startsWith(MainActivity.ORIGIN + "/spike/")) { topNavigations += u; return true }
                return false
            }
        }
        web.loadUrl(MainActivity.ORIGIN + "/spike/host.html")
        val h = Handler(Looper.getMainLooper())
        val poll = object : Runnable {
            override fun run() {
                web.evaluateJavascript("JSON.stringify(window.spikeResults||null)") { v ->
                    val o = runCatching { JSONObject(org.json.JSONTokener(v).nextValue() as String) }.getOrNull()
                    if (o != null && o.optBoolean("done") && o.has("host_fetch_hub")) {
                        // A moment more, for the outer frame's fetch and a late navigation.
                        h.postDelayed({
                            web.evaluateJavascript("JSON.stringify(window.spikeResults)") { v2 ->
                                results = runCatching { JSONObject(org.json.JSONTokener(v2).nextValue() as String) }.getOrNull()
                            }
                        }, 1500)
                    } else h.postDelayed(this, 200)
                }
            }
        }
        h.postDelayed(poll, 300)
    }

    companion object {
        const val SANDBOX = "sandbox.ravenry.test"
        @Volatile var results: JSONObject? = null
        val hubRequests = CopyOnWriteArrayList<String>()
        val topNavigations = CopyOnWriteArrayList<String>()
        val shellMessages = CopyOnWriteArrayList<String>()
    }
}
