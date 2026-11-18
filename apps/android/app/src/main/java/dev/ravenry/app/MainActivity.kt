package dev.ravenry.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognizerIntent
import android.util.Log
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.unifiedpush.android.connector.UnifiedPush
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The phone board in one WebView, and the bridge to it (docs/PHONE.md
 * section 7). The page comes from the app's own assets; every byte to the
 * hub goes through [HubClient], so the pin and the token stay here.
 */
class MainActivity : FragmentActivity() {
    private lateinit var web: WebView
    private lateinit var box: FrameLayout
    private lateinit var secret: SecretField
    private val main = Handler(Looper.getMainLooper())
    private var out: JavaScriptReplyProxy? = null
    private var pending: String? = null
    private var events: Closeable? = null
    /** The launch's hold and exit (docs/PHONE.md, The launch); null on a warm start. */
    private var ink: InkLaunch? = null
    private val sockets = ConcurrentHashMap<Int, WebSocket>()
    private val nextSid = AtomicInteger(1)
    private var backWaiting = false
    private lateinit var back: OnBackPressedCallback
    /** The demo (Demo.kt): sample projects, no Mac, no connection; only while no Mac is paired. */
    private var demo = false

    private var photoReply: Int? = null
    private var photoProject: String? = null
    private var photoFile: File? = null
    private var permReply: (() -> Unit)? = null
    private var permFail: (() -> Unit)? = null
    private var speechReply: Int? = null
    private var recorder: android.media.MediaRecorder? = null
    private var voiceFile: File? = null
    private var voiceAt = 0L

    private val takePicture = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val id = photoReply ?: return@registerForActivityResult
        photoReply = null
        val f = photoFile
        val project = photoProject
        if (!ok || f == null || !f.exists() || project == null) { reply(id, false, error = "No photo was taken."); return@registerForActivityResult }
        Hub.io.execute { upload(id, project, f, "image/jpeg", null, thumb(f)) }
    }

    private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val ok = permReply; val no = permFail
        permReply = null; permFail = null
        if (granted) ok?.invoke() else no?.invoke()
    }

    // The board's Attach (an <input type="file"> in the composer and the
    // plan's boxes): Android's own document picker, which needs no storage
    // permission (it hands the app only what the person picked). The page
    // then reads the files and posts them as on the Mac (POST /api/inbox).
    private var chooser: android.webkit.ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = chooser ?: return@registerForActivityResult
        chooser = null
        cb.onReceiveValue(if (r.resultCode == RESULT_OK) picked(r.data) else null)
    }

    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val id = speechReply ?: return@registerForActivityResult
        speechReply = null
        val text = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (text == null) reply(id, false, error = "Nothing was heard.") else reply(id, true, JSONObject().put("text", text))
    }

    private val loader by lazy {
        WebViewAssetLoader.Builder().addPathHandler("/phone/") { path ->
            runCatching {
                val clean = path.substringBefore('?').ifEmpty { "index.html" }
                if (clean.contains("..")) return@runCatching null
                val type = when (clean.substringAfterLast('.').lowercase()) {
                    "html" -> "text/html"; "js", "mjs" -> "text/javascript"; "css" -> "text/css"; "svg" -> "image/svg+xml"
                    "png" -> "image/png"; "woff2" -> "font/woff2"; "json" -> "application/json"; "wasm" -> "application/wasm"
                    "txt" -> "text/plain" // licences.txt, the open source licences (Settings)
                    else -> "application/octet-stream"
                }
                WebResourceResponse(type, if (type.startsWith("text/") || type.endsWith("json")) "utf-8" else null, assets.open("phone/$clean"))
            }.getOrNull()
        }.build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.url?.let { outState.putString(STATE_URL, it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        demo = intent?.getBooleanExtra(EXTRA_DEMO, false) == true && Store.get(this).paired() == null
        if (demo) { Demo.attach(this); Log.i("Ravenry", "demo: open (no Mac, no connection)") }
        if (!demo && Store.get(this).paired() == null) {
            startActivity(Intent(this, PairActivity::class.java))
            finish(); return
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        box = FrameLayout(this)
        web = WebView(this)
        box.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(box)
        ink = if (demo) null else InkLaunch.begin(this, box, web, retry = { conn.reconnect() }, why = { Hub.get(this)?.let { reachOf(it.allHosts, null).words } ?: getString(R.string.mac_no_answer) }, pairAgain = { pairAgain() })
        ViewCompat.setOnApplyWindowInsetsListener(box) { v, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, box).isAppearanceLightStatusBars = !night
        WindowCompat.getInsetsController(window, box).isAppearanceLightNavigationBars = !night

        // Parts of a body a page that is gone was sending (http.part).
        uploads.execute { File(cacheDir, "uploads").listFiles()?.forEach { it.delete() } }
        secret = SecretField(this, box)
        secret.onCount = { n -> event(JSONObject().put("event", "secret.count").put("n", n)) }
        secret.onSend = { sendSecret(null) }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            setSupportZoom(false)
            // The terminal measures its columns at the size it draws them.
            textZoom = 100
            // window.open(link) reaches onCreateWindow, which hands it to the browser.
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false)
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.win))
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                // A throwaway WebView that only learns the address, then the phone's browser opens it.
                val catcher = WebView(this@MainActivity)
                catcher.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                        val u = r.url
                        if (u.scheme == "https" || u.scheme == "http") runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                        v.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = catcher
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = callback
                val types = params.acceptTypes.orEmpty().map { it.trim() }.filter { it.contains('/') }.distinct()
                val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(types.singleOrNull() ?: "*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                if (types.size > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                return try { pickFiles.launch(i); true } catch (e: Exception) { chooser = null; false }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) Log.d("RavenryPage", "${m.messageLevel()} ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                if (u.host != HOST) return null
                val path = u.path ?: "/"
                // The demo: the app's own files only (Demo.kt), never the hub.
                if (demo && !(path.startsWith("/phone/") && !path.startsWith("/phone/hub/"))) return Demo.resource(this@MainActivity, u, request.method)
                if (path.startsWith("/phone/hub/")) {
                    // Only the page itself: a frame of another origin (an MCP
                    // App's sandbox) never reads the hub through this door.
                    if (request.method != "GET" || !HubGate.allowed(request.requestHeaders)) return HubGate.refused()
                    return hubResource(u, range = HubGate.range(request.requestHeaders))
                }
                if (path.startsWith("/phone/")) return loader.shouldInterceptRequest(u)
                // The rest of the origin is the hub's own board, the app's
                // home (docs/PHONE.md section 1): its page, opened in this
                // WebView, and its files and pictures for that page only.
                if (request.method != "GET") return HubGate.refused()
                if (request.isForMainFrame) return boardPage(u)
                if (!HubGate.allowed(request.requestHeaders)) return HubGate.refused()
                return hubResource(u, board = true, range = HubGate.range(request.requestHeaders))
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == HOST) return false
                // Links leave the app for the phone's own browser.
                if (u.scheme == "https" || u.scheme == "http") runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                recreate(); return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Only the page's own origin: an iframe of another origin never
            // sees ravenryShell (the spike in androidTest proves it).
            WebViewCompat.addWebMessageListener(web, "ravenryShell", setOf(ORIGIN)) { _, message, _, isMainFrame, proxy ->
                if (isMainFrame) receive(message, proxy)
            }
        }
        back = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (out == null) { leave(); return }
                backWaiting = true
                event(JSONObject().put("event", "back"))
                main.postDelayed({ if (backWaiting) { backWaiting = false; leave() } }, 700)
            }
        }
        onBackPressedDispatcher.addCallback(this, back)
        pending = intent?.getStringExtra(Notifier.EXTRA_ALERT)
        // A new theme (light or dark) or a new window size makes a new
        // activity: the page comes back on the screen it was on.
        val was = savedInstanceState?.getString(STATE_URL)?.takeIf { it.startsWith("$ORIGIN/") && pending == null }
        web.loadUrl(was ?: "$ORIGIN/")
        // The alerts are asked once, on their own screen right after pairing
        // (PairActivity's Alerts step); Settings has the way back to them.
        if (demo) return
        Push.register(this)
        // Paired now (the first open after pairing too): hold the connection,
        // unless Settings turned that off.
        if (Store.get(this).stayConnected) ConnectionService.start(this)
    }

    /**
     * Back at home: the app goes to the background as it is (the board stays
     * loaded), so coming back is instant and shows no launch (docs/PHONE.md,
     * The launch: a warm start has none).
     */
    private fun leave() {
        // Back at the demo's home: out of the demo, to the pairing screen.
        if (demo) { leaveDemo(); return }
        if (!moveTaskToBack(true)) {
            back.isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            back.isEnabled = true
        }
    }

    /**
     * Out of the demo (its bar's Pair your Mac, Back at its home, Leave the
     * demo): the pairing screen, and nothing of the demo kept. Its page's
     * visit lived in this WebView's sessionStorage, which goes with it (the
     * page cleared it first); its alert leaves the shade.
     */
    private fun leaveDemo() {
        Demo.clearAlerts(this)
        Demo.attach(null)
        Log.i("Ravenry", "demo: left, ${Demo.served} of the app's own files served, no connection made")
        startActivity(Intent(this, PairActivity::class.java))
        finish()
    }

    /** The demo alert's button (Demo.action): the page answers its card. */
    fun demoAnswer(checkpoint: String, answer: JSONObject) = event(JSONObject().put("event", "demo.action").put("checkpoint", checkpoint).put("answer", answer))

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val a = intent.getStringExtra(Notifier.EXTRA_ALERT) ?: return
        if (out != null) event(JSONObject().put("event", "open").put("alert", parse(a))) else pending = a
    }

    override fun onStart() {
        super.onStart()
        if (::web.isInitialized && !demo) conn.start()
    }

    // Back in front (from Android's notification settings too): the board's
    // Settings row learns whether Android shows the alerts now.
    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) event(JSONObject().put("event", "alerts").put("on", Notifier.allowed(this)))
    }

    override fun onStop() {
        conn.stop()
        super.onStop()
    }

    override fun onDestroy() {
        events?.close(); events = null
        sockets.values.forEach { it.cancel() }; sockets.clear()
        if (::secret.isInitialized) secret.close()
        recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
        if (::web.isInitialized) web.destroy()
        if (demo && isFinishing) Demo.attach(null)
        super.onDestroy()
    }

    // ------------------------------------------------------------ the bridge

    private fun parse(text: String): Any = runCatching { JSONTokener(text).nextValue() }.getOrDefault(text)

    private fun post(text: String) = main.post { out?.postMessage(text) }

    private fun reply(id: Int, ok: Boolean, result: Any? = null, error: String? = null) {
        val o = JSONObject().put("id", id).put("ok", ok)
        if (ok) o.put("result", result ?: JSONObject.NULL) else o.put("error", error ?: "It did not work.")
        post(o.toString())
    }

    private fun event(o: JSONObject) = post(o.toString())

    private fun receive(message: WebMessageCompat, proxy: JavaScriptReplyProxy) {
        out = proxy
        val o = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return
        val id = o.optInt("id", -1)
        val op = o.str("op", "")
        if (o.optInt("v", 1) != 1) { reply(id, false, error = "This app speaks bridge version 1."); return }
        try {
            // The demo answers the board in its page: nothing here reaches a hub.
            if (demo && op in Demo.HUB_OPS) { reply(id, false, error = "Not in the demo."); return }
            handle(id, op, o)
        } catch (e: Exception) {
            reply(id, false, error = e.message ?: e.javaClass.simpleName)
        }
    }

    private fun hub(): HubClient = Hub.get(this) ?: error("This phone is not paired.")

    private fun handle(id: Int, op: String, o: JSONObject) {
        when (op) {
            "hello" -> {
                val p = Store.get(this).paired()
                val r = JSONObject().put("v", 1).put("platform", "android").put("app", BuildConfig.VERSION_NAME)
                    .put("hub", JSONObject().put("name", p?.hubName?.let(MacName::say)).put("port", p?.port))
                    .put("device", JSONObject().put("id", p?.deviceId).put("name", p?.deviceName))
                    .put("features", JSONArray(features()))
                    .put("pending", pending?.let { parse(it) } ?: JSONObject.NULL)
                    .put("launch", ink?.kind ?: JSONObject.NULL)
                if (demo) r.put("demo", true).put("hub", JSONObject.NULL).put("device", JSONObject.NULL)
                pending = null
                reply(id, true, r)
            }
            // A request of the board's page (src/board.ts's fetch): any
            // method, its body and headers as they are, the answer's bytes.
            "http" -> {
                val method = o.str("method", "GET").uppercase()
                val path = o.str("path", "")
                if (!path.startsWith("/")) { reply(id, false, error = "A path starts with /."); return }
                val bytes = o.str("b64")?.let { Base64.getDecoder().decode(it) }
                // A body sent in parts (http.part) is read from its file as it goes, then deleted.
                val parts = o.str("upload")?.let { partFile(it) ?: run { reply(id, false, error = "Not an upload."); return } }
                val hs = o.optJSONObject("headers")
                val headers = mutableMapOf<String, String>()
                hs?.keys()?.forEach { k -> if (k.lowercase() in PASS_HEADERS) hs.str(k)?.let { headers[k] = it } }
                Hub.io.execute {
                    val asked = SystemClock.elapsedRealtime()
                    try {
                        val type = headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value
                        val body = when {
                            method == "GET" || method == "HEAD" -> null
                            parts != null -> parts.asRequestBody(type?.toMediaTypeOrNull())
                            else -> (bytes ?: ByteArray(0)).toRequestBody(type?.toMediaTypeOrNull())
                        }
                        hub().execute(method, path, body, headers).use { r ->
                            val out = r.body?.bytes() ?: ByteArray(0)
                            answered()
                            reply(id, true, JSONObject().put("status", r.code).put("type", r.header("Content-Type") ?: "application/octet-stream").put("b64", Base64.getEncoder().encodeToString(out)))
                        }
                    } catch (e: Exception) {
                        reply(id, false, error = unreachable(e, asked))
                    } finally {
                        parts?.delete()
                    }
                }
            }
            // One part of a body too big for one message (src/board.ts: a file the
            // board attaches), added to its file in order; `http` with `upload` sends it.
            "http.part" -> {
                val f = partFile(o.str("upload", "")) ?: run { reply(id, false, error = "Not an upload."); return }
                val b64 = o.str("b64", "")
                uploads.execute {
                    try {
                        val chunk = Base64.getDecoder().decode(b64)
                        if (f.length() + chunk.size > PARTS_MAX) { f.delete(); reply(id, false, error = "Too big to send."); return@execute }
                        java.io.FileOutputStream(f, true).use { it.write(chunk) }
                        reply(id, true)
                    } catch (e: Exception) { f.delete(); reply(id, false, error = "It could not be read.") }
                }
            }
            "reach.now" -> reply(id, true, if (demo) JSONObject.NULL else lastReach ?: JSONObject.NULL)
            "reach.retry" -> { lastReach = null; Hub.io.execute { runCatching { hub().call("GET", "/api/phone/hello") }.onSuccess { answered(); main.post { web.reload() } }.onFailure { unreachable(it) } }; reply(id, true) }
            // The board's background and theme for the system bars (src/board.ts).
            "bars" -> {
                val light = o.optBoolean("light", false)
                val c = Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(o.str("color", ""))?.groupValues
                main.post {
                    if (c != null) box.setBackgroundColor(android.graphics.Color.rgb(c[1].toInt(), c[2].toInt(), c[3].toInt()))
                    WindowCompat.getInsetsController(window, box).isAppearanceLightStatusBars = light
                    WindowCompat.getInsetsController(window, box).isAppearanceLightNavigationBars = light
                }
                reply(id, true)
            }
            "open.tailscale" -> { Reach.openTailscale(this); reply(id, true) }
            // This phone's own alerts: whether Android shows them (the app's
            // notifications and its Needs you channel), and its settings for them.
            "alerts.state" -> reply(id, true, JSONObject().put("on", Notifier.allowed(this)))
            "alerts.settings" -> {
                runCatching { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
                reply(id, true)
            }
            "hub.call" -> {
                val method = o.str("method", "GET")
                val path = o.str("path", "")
                if (!path.startsWith("/")) { reply(id, false, error = "A path starts with /."); return }
                val b = o.opt("body")
                val json = when (b) { null, JSONObject.NULL -> null; is String -> b; else -> b.toString() }
                Hub.io.execute {
                    val asked = SystemClock.elapsedRealtime()
                    try {
                        val r = hub().call(method, path, json)
                        answered()
                        reply(id, true, JSONObject().put("status", r.status).put("body", if (r.text.isEmpty()) JSONObject.NULL else parse(r.text)))
                    } catch (e: Exception) {
                        reply(id, false, error = unreachable(e, asked))
                    }
                }
            }
            "hub.events" -> {
                eventsWanted = o.optBoolean("on", true)
                startEvents()
                reply(id, true)
            }
            "conn.now" -> reply(id, true, if (demo) JSONObject.NULL else conn.json())
            "conn.reconnect" -> { conn.reconnect(); reply(id, true) }
            "ink.ready" -> { ink?.ready(o); reply(id, true) }
            "socket.open" -> {
                val sid = nextSid.getAndIncrement()
                val path = o.str("path", "")
                val proto = o.str("protocol")
                Hub.io.execute {
                    try {
                        val ws = hub().socket(path, proto, object : WebSocketListener() {
                            override fun onOpen(webSocket: WebSocket, response: Response) { answered() }
                            override fun onMessage(webSocket: WebSocket, text: String) { event(JSONObject().put("event", "socket.message").put("sid", sid).put("text", text)) }
                            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { event(JSONObject().put("event", "socket.message").put("sid", sid).put("b64", Base64.getEncoder().encodeToString(bytes.toByteArray()))) }
                            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
                            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { sockets.remove(sid); event(JSONObject().put("event", "socket.close").put("sid", sid).put("code", code).put("reason", reason)) }
                            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                                sockets.remove(sid)
                                event(JSONObject().put("event", "socket.close").put("sid", sid).put("code", response?.code ?: 1006).put("reason", t.message ?: "failed"))
                            }
                        })
                        sockets[sid] = ws
                        reply(id, true, JSONObject().put("sid", sid))
                    } catch (e: Exception) { reply(id, false, error = unreachable(e)) }
                }
            }
            "socket.send" -> {
                val ws = sockets[o.optInt("sid")] ?: run { reply(id, false, error = "That connection is closed."); return }
                val ok = if (o.has("b64")) ws.send(Base64.getDecoder().decode(o.getString("b64")).toByteString()) else ws.send(o.str("text", ""))
                if (ok) reply(id, true) else reply(id, false, error = "That connection is closed.")
            }
            "socket.close" -> { sockets.remove(o.optInt("sid"))?.close(1000, null); reply(id, true) }
            "biometric" -> Biometrics.ask(this, o.str("title", getString(R.string.run)), o.str("subtitle")) { ok, err ->
                if (ok) reply(id, true, JSONObject().put("ok", true)) else reply(id, false, error = err ?: "Not confirmed.")
            }
            "photo" -> {
                val project = o.str("projectId") ?: run { reply(id, false, error = "Which session's project?"); return }
                needPermission(Manifest.permission.CAMERA, {
                    val dir = File(cacheDir, "shots").apply { mkdirs() }
                    val f = File(dir, "photo-${stamp()}.jpg")
                    photoFile = f; photoProject = project; photoReply = id
                    takePicture.launch(FileProvider.getUriForFile(this, "$packageName.files", f))
                }, { reply(id, false, error = "The camera is off for Ravenry. Allow it in Settings.") })
            }
            "voice.start" -> needPermission(Manifest.permission.RECORD_AUDIO, {
                try { startVoice(); reply(id, true) } catch (e: Exception) { reply(id, false, error = "The microphone did not start.") }
            }, { reply(id, false, error = "The microphone is off for Ravenry. Allow it in Settings.") })
            "voice.stop" -> {
                val project = o.str("projectId")
                val r = recorder ?: run { reply(id, false, error = "Nothing is recording."); return }
                val ms = System.currentTimeMillis() - voiceAt
                runCatching { r.stop() }; r.release(); recorder = null
                val f = voiceFile
                if (f == null || project == null) { reply(id, false, error = "Which session's project?"); return }
                Hub.io.execute { upload(id, project, f, "audio/mp4", ms) }
            }
            "voice.cancel" -> {
                recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
                voiceFile?.delete(); voiceFile = null
                reply(id, true)
            }
            "secret.open" -> {
                val cp = o.str("checkpoint") ?: run { reply(id, false, error = "Which checkpoint?"); return }
                secret.open(cp, rect(o), o.optBoolean("dark", isNight()), o.optDouble("size", 16.0).toFloat())
                if (!BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                reply(id, true)
            }
            "secret.move" -> {
                secret.move(rect(o))
                if (o.has("reveal")) secret.reveal(o.optBoolean("reveal"))
                reply(id, true)
            }
            "secret.send" -> sendSecret(id)
            "secret.close" -> { closeSecret(); reply(id, true) }
            "speech" -> {
                val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                if (!canSpeech()) { reply(id, false, error = "This phone has no voice typing."); return }
                speechReply = id
                speech.launch(i)
            }
            "alerts.clear" -> { o.str("id")?.let { Notifier.cancel(this, it) }; reply(id, true) }
            // The demo: out of it (its bar, its settings), and its alert when its question arrives.
            "demo.leave" -> { reply(id, true); if (demo) main.post { leaveDemo() } }
            "demo.alert" -> {
                val a = o.optJSONObject("alert")
                reply(id, true, JSONObject().put("posted", demo && a != null && Demo.post(this, a.toString())))
            }
            // The page that says the Mac did not answer: Scan the code again.
            "pair.again" -> { reply(id, true); if (!demo) main.post { pairAgain() } }
            "pair.reset" -> {
                if (demo) { reply(id, true); main.post { leaveDemo() }; return }
                // The screen changes on the tap; the computer is told in the
                // background, now and later until it answers (Revokes).
                reply(id, true)
                events?.close(); events = null
                Revokes.signOut(this)
                startActivity(Intent(this, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
            // Settings (the phone board's #/settings): push and the held connection.
            "push.status" -> reply(id, true, Push.status(this))
            "push.set" -> {
                val on = o.optBoolean("on", true)
                Store.get(this).pushOff = !on
                if (on) Push.register(this) else { Push.unregister(this); Push.target(applicationContext, JSONObject().put("kind", "none")) }
                reply(id, true, Push.status(this))
            }
            "connection.get" -> reply(id, true, JSONObject().put("on", Store.get(this).stayConnected))
            "connection.set" -> {
                val on = o.optBoolean("on", true)
                Store.get(this).stayConnected = on
                if (on) ConnectionService.start(this) else ConnectionService.stop(this)
                reply(id, true, JSONObject().put("on", on))
            }
            "open.settings" -> {
                runCatching { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
                reply(id, true)
            }
            "back.done" -> {
                val handled = o.optBoolean("handled", true)
                if (backWaiting) { backWaiting = false; if (!handled) leave() }
                reply(id, true)
            }
            else -> reply(id, false, error = "Unknown op: $op")
        }
    }

    private fun rect(o: JSONObject): FloatArray {
        val r = o.optJSONObject("rect") ?: JSONObject()
        return floatArrayOf(r.optDouble("x", 0.0).toFloat(), r.optDouble("y", 0.0).toFloat(), r.optDouble("w", r.optDouble("width", 200.0)).toFloat(), r.optDouble("h", r.optDouble("height", 44.0)).toFloat())
    }

    private fun closeSecret() {
        secret.close()
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    /** The shell answers the checkpoint itself; the page learns only whether it went. */
    private fun sendSecret(id: Int?) {
        val cp = secret.checkpoint
        val s = secret.take()
        if (cp == null || s == null) { id?.let { reply(it, false, error = "No secret is open.") }; return }
        if (s.length < 4) {
            val err = "A secret has at least 4 characters."
            id?.let { reply(it, false, error = err) } ?: event(JSONObject().put("event", "secret.done").put("ok", false).put("error", err))
            return
        }
        val body = JSONObject().put("id", cp).put("secret", s).put("by", "phone").toString()
        Hub.io.execute {
            val r = runCatching { hub().call("POST", "/api/checkpoints/answer", body) }
            val ok = r.getOrNull()?.status == 200
            val err = if (ok) null else r.exceptionOrNull()?.let { unreachable(it) }
                ?: runCatching { JSONObject(r.getOrThrow().text).str("error") }.getOrNull() ?: "It was not sent."
            main.post {
                if (ok) closeSecret()
                if (id != null) { if (ok) reply(id, true, JSONObject().put("ok", true)) else reply(id, false, error = err) }
                event(JSONObject().put("event", "secret.done").put("ok", ok).put("error", err ?: JSONObject.NULL))
            }
        }
    }

    /** A body's parts on their way (`http.part`), one file per upload, in the app's cache. */
    private val uploads = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun partFile(upload: String): File? {
        if (!Regex("[A-Za-z0-9_-]{4,64}").matches(upload)) return null
        return File(File(cacheDir, "uploads").apply { mkdirs() }, upload)
    }

    /** The documents the picker gave back: one, or several (its clip). */
    private fun picked(data: Intent?): Array<Uri>? {
        val clip = data?.clipData
        val out = if (clip != null) (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } else listOfNotNull(data?.data)
        return out.distinct().toTypedArray().takeIf { it.isNotEmpty() }
    }

    /** A small copy of the photo for the page, about 300 px, as a data URL. */
    private fun thumb(f: File): String? = runCatching {
        val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(f.absolutePath, o)
        var sample = 1
        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= 300) sample *= 2
        val b = android.graphics.BitmapFactory.decodeFile(f.absolutePath, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@runCatching null
        val k = 300f / maxOf(b.width, b.height)
        val small = if (k < 1f) android.graphics.Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true) else b
        val rotated = rotate(f, small)
        val out = java.io.ByteArrayOutputStream()
        rotated.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
        "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(out.toByteArray())
    }.getOrNull()

    private fun rotate(f: File, b: android.graphics.Bitmap): android.graphics.Bitmap {
        val deg = when (androidx.exifinterface.media.ExifInterface(f.absolutePath).getAttributeInt(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION, 1)) {
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> return b
        }
        return android.graphics.Bitmap.createBitmap(b, 0, 0, b.width, b.height, android.graphics.Matrix().apply { postRotate(deg) }, true)
    }

    private fun upload(id: Int, project: String, f: File, type: String, ms: Long?, thumb: String? = null) {
        try {
            val r = hub().upload("/api/inbox/" + Uri.encode(project), f.readBytes(), f.name, type)
            f.delete()
            val b = runCatching { JSONObject(r.text) }.getOrNull() ?: JSONObject()
            if (r.status != 200) { reply(id, false, error = b.str("error") ?: "It was not sent."); return }
            val res = JSONObject().put("path", b.str("path") ?: JSONObject.NULL).put("short", b.str("short") ?: JSONObject.NULL).put("name", f.name)
            if (ms != null) res.put("ms", ms)
            if (thumb != null) res.put("thumb", thumb)
            reply(id, true, res)
        } catch (e: Exception) {
            reply(id, false, error = unreachable(e))
        }
    }

    private fun startVoice() {
        val dir = File(cacheDir, "shots").apply { mkdirs() }
        val f = File(dir, "voice-${stamp()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) android.media.MediaRecorder(this) else android.media.MediaRecorder()
        r.setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
        r.setAudioEncodingBitRate(64000)
        r.setAudioSamplingRate(44100)
        r.setOutputFile(f.absolutePath)
        r.prepare(); r.start()
        recorder = r; voiceFile = f; voiceAt = System.currentTimeMillis()
    }

    private fun needPermission(p: String, granted: () -> Unit, denied: () -> Unit) {
        if (ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED) { granted(); return }
        permReply = granted; permFail = denied
        askPermission.launch(p)
    }

    /**
     * The board's page (the hub's `/`), with the app's layer (board.js,
     * apps/phone/src/board.ts) first in its head, so the board's requests
     * go through the shell.
     */
    private fun boardPage(u: Uri): WebResourceResponse {
        return try {
            val r = hub().execute("GET", "/")
            val html = r.body?.string() ?: ""
            r.close()
            if (r.code != 200) return hubResource(u, board = true)
            val page = html.replaceFirst("<head>", "<head>\n<script src=\"/phone/board.js\"></script>")
            WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(page.toByteArray()))
        } catch (e: Exception) {
            // The computer did not answer: the app's own page says why (its
            // board.js still runs there, with the bar and Try again).
            val w = reachOf(Hub.get(this)?.allHosts ?: emptyList(), e)
            val page = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><script src=\"/phone/board.js\"></script><style>body{margin:0;background:#161618;color:#A1A1A8}@media (prefers-color-scheme: light){body{background:#F1F0ED;color:#5F5F66}}</style></head><body data-unreached=\"${w.reason}\"></body></html>"
            WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(page.toByteArray()))
        }
    }

    /** A picture or file of the hub: `hub/<path>` relative to the page (or the board's own path), fetched with the pin and the token. */
    private fun hubResource(u: Uri, board: Boolean = false, range: String? = null): WebResourceResponse {
        val path = (if (board) (u.encodedPath ?: "/") else "/" + (u.encodedPath ?: "").removePrefix("/phone/hub/")) + (u.encodedQuery?.let { "?$it" } ?: "")
        return try {
            // A player's part of a video (a pick's, the pickvideo round): asked for and passed on as the hub answers it (206).
            val r = hub().execute("GET", path, headers = if (range != null) mapOf("Range" to range) else emptyMap())
            val type = r.header("Content-Type")?.substringBefore(';')?.trim() ?: "application/octet-stream"
            // The hub's own policy goes with it: a pick's HTML or SVG variant
            // comes with `Content-Security-Policy: sandbox`, so it never runs
            // as the page, whatever frame shows it.
            val headers = mutableMapOf("Cache-Control" to "no-cache", "X-Content-Type-Options" to "nosniff")
            r.header("Content-Security-Policy")?.let { headers["Content-Security-Policy"] = it }
            for (k in listOf("Content-Range", "Accept-Ranges")) r.header(k)?.let { headers[k] = it }
            val body = r.body
            if (range != null && body != null && (r.code == 206 || r.code == 200)) {
                // A player's part (the pickvideo round's fourth part, 2026-11-16): passed on as it comes, not once the
                // whole of it has (the player asks for the rest of the file at each start and seek); the player
                // closing it (a seek, another video, the viewer gone) stops the hub's answer.
                r.header("Content-Length")?.let { headers["Content-Length"] = it }
                return WebResourceResponse(type, null, r.code, r.message.ifEmpty { if (r.code == 206) "Partial Content" else "OK" }, headers, body.byteStream())
            }
            val bytes = body?.bytes() ?: ByteArray(0)
            r.close()
            if (r.code == 206) headers["Content-Length"] = bytes.size.toString()
            WebResourceResponse(type, null, r.code, r.message.ifEmpty { "OK" }, headers, ByteArrayInputStream(bytes))
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    private fun features(): List<String> {
        val f = mutableListOf("secret", "alerts.state", "http.parts")
        if (runCatching { UnifiedPush.getDistributors(this).isNotEmpty() }.getOrDefault(false)) f += "push"
        val bio = BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        // The demo asks for a fingerprint before Run only when one is set up: a phone with none still sees the command run.
        if (if (demo) bio == BiometricManager.BIOMETRIC_SUCCESS else bio != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE && bio != BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) f += "biometric"
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) f += "photo"
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) f += "voice"
        if (canSpeech()) f += "speech"
        return f
    }

    private fun canSpeech() = packageManager.queryIntentActivities(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0).isNotEmpty()

    private fun isNight() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    // ------------------------------------------------------------ the live stream and the connection

    private var eventsWanted = false

    /** The hub's live stream for the page, opened again from scratch (Reconnect). */
    private fun startEvents() {
        events?.close(); events = null
        if (!eventsWanted) return
        events = hub().events("/api/events", { name, data ->
            event(JSONObject().put("event", "hub").put("name", name).put("data", parse(data)))
        }, { up, err ->
            if (up) answered()
            // Never the exception's own words (a host name): the reason.
            val words = if (up) null else Hub.get(this)?.let { c -> if (err == "signed out") err else reachOf(c.allHosts, null).words }
            event(JSONObject().put("event", "link").put("state", if (up) "up" else "down").put("error", words ?: JSONObject.NULL))
            main.post { if (up) conn.linkUp() else if (err != "signed out") conn.linkDown() }
        })
    }

    private val conn = ConnWatch()

    /**
     * Whether the phone reaches the Mac and how (docs/PHONE.md, The
     * connection), for the board's chip: the path in use (Reach.via), up,
     * reconnecting (the stream or a probe failed, fewer than three times in
     * a row) or offline (three: with the reason words and the bar), since
     * when it is up, and a measured round trip (GET /api/phone/hello, every
     * 30 s while up, every 3 s while not).
     */
    inner class ConnWatch {
        var state = "reconnecting"; private set
        private var via = "wifi"
        private var since: Long? = null
        private var rtt: Long? = null
        private var fails = 0
        private var probing = false
        private var stopped = false
        private val tick = Runnable { probe() }

        fun json(): JSONObject {
            val r = lastReach
            return JSONObject().put("state", state).put("via", via).put("since", since ?: JSONObject.NULL).put("rtt", rtt ?: JSONObject.NULL)
                .put("reason", if (state == "offline") r.str("reason") ?: JSONObject.NULL else JSONObject.NULL)
                .put("words", if (state == "offline") r.str("words") ?: JSONObject.NULL else JSONObject.NULL)
                .put("mac", Store.get(this@MainActivity).paired()?.hubName?.let(MacName::say) ?: JSONObject.NULL)
        }

        private fun emit() = event(json().put("event", "conn"))

        private fun set(s: String) {
            if (s == "up" && state != "up") since = System.currentTimeMillis()
            if (s != "up") since = null
            val changed = s != state
            state = s
            if (changed || s == "up") emit()
        }

        fun start() { stopped = false; Hub.onNetwork = { main.post { if (!stopped) schedule(500) } }; schedule(0) }
        fun stop() { stopped = true; Hub.onNetwork = null; main.removeCallbacks(tick) }
        private fun schedule(ms: Long) { main.removeCallbacks(tick); if (!stopped) main.postDelayed(tick, ms) }

        fun linkUp() {
            fails = 0
            Hub.get(this@MainActivity)?.let { via = Reach.via(it.host, it.allHosts) }
            if (state != "up") { set("up"); ink?.answered(); probe() }
        }

        fun linkDown() {
            if (state == "up") set("reconnecting")
            schedule(3000)
        }

        fun reconnect() {
            fails = 0
            clearReach()
            Hub.reset()
            set("reconnecting")
            if (eventsWanted) startEvents()
            probe()
        }

        /**
         * The hub answered a request or the stream: when the watch did not
         * think it up, it checks now, so the chip, the bar and the
         * notification follow at once rather than at the next 3 s check.
         */
        fun heard() { if (state != "up" && !stopped) probe() }

        /** A request failed: check now whether the Mac still answers (the bar is up meanwhile). */
        fun suspect() { if (!stopped) schedule(0) }

        private fun probe() {
            if (probing || stopped) return
            probing = true
            Hub.io.execute {
                val c = Hub.get(this@MainActivity)
                val r = runCatching { c?.probe() ?: throw java.io.IOException("not paired") }
                main.post {
                    probing = false
                    r.fold({ (host, ms) ->
                        rtt = ms; fails = 0
                        val was = via
                        via = Reach.via(host, c!!.allHosts)
                        answered()
                        // The path changed (home again, or away): the stream follows it now.
                        if (state == "up" && was != via && eventsWanted) startEvents()
                        if (state != "up") {
                            set("up")
                            ink?.answered()
                            // Back: the stream too, at once, rather than at its own next try.
                            if (eventsWanted) startEvents()
                        } else emit()
                        schedule(30_000)
                    }, { e ->
                        fails++
                        if (fails >= 3 && c != null) {
                            reachOf(c.allHosts, e)
                            set("offline")
                            lastReach?.let { rr -> event(JSONObject(rr.toString()).put("event", "reach")); ink?.unreached(rr.str("words", "")) }
                        } else if (state != "offline") set("reconnecting")
                        schedule(3000)
                    })
                }
            }
        }
    }

    /** The last reason the computer could not be reached, for the board's bar (null once it answers). */
    @Volatile private var lastReach: JSONObject? = null

    /** When the hub last answered anything (a request, the stream, a check), on the elapsed clock. */
    @Volatile private var answeredAt = 0L

    /**
     * The hub answered: whatever said it could not be reached goes, by
     * every path (docs/PHONE.md, The connection): the board's bar (an empty
     * `reach`), the chip (the watch checks now when it was not up) and the
     * ongoing notification (the connection's stream tries again now).
     */
    private fun answered() {
        answeredAt = SystemClock.elapsedRealtime()
        clearReach()
        main.post { if (conn.state != "up") { conn.heard(); ConnectionService.poke() } }
    }

    private fun clearReach() {
        if (lastReach == null) return
        lastReach = null
        event(JSONObject().put("event", "reach").put("reason", JSONObject.NULL).put("words", JSONObject.NULL))
    }

    /**
     * Scan the code again, from the page that says the Mac did not answer:
     * the pairing screen over the board, the pairing kept until a new one
     * is made; its Back (and Android's) comes back here.
     */
    private fun pairAgain() {
        Log.i("Ravenry", "pairing: again, from the page that says the Mac did not answer")
        startActivity(Intent(this, PairActivity::class.java).putExtra(PairActivity.AGAIN, true))
    }

    private fun reachOf(hosts: List<String>, e: Throwable?): Reach.Why {
        val w = Reach.why(this, hosts, e)
        lastReach = JSONObject().put("reason", w.reason).put("words", w.words)
        return w
    }

    /**
     * What a failed request says: why the computer cannot be reached, never
     * a host name. The bar shows it, unless the hub answered something else
     * after this request was asked (a slow request that gave up after the
     * connection came back is not news), and the watch checks at once.
     */
    private fun unreachable(e: Throwable, asked: Long = SystemClock.elapsedRealtime()): String {
        if (e !is java.io.IOException) return e.message ?: "It did not work."
        if (asked < answeredAt) return Reach.why(this, Hub.get(this)?.allHosts ?: emptyList(), e).words
        val w = reachOf(Hub.get(this)?.allHosts ?: emptyList(), e)
        lastReach?.let { r -> event(JSONObject(r.toString()).put("event", "reach")) }
        main.post { conn.suspect() }
        return w.words
    }

    private fun stamp() = SimpleDateFormat("HHmm-ss", Locale.US).format(Date())

    /** For the instrumented tests: the page's WebView. */
    @androidx.annotation.VisibleForTesting
    fun webView(): WebView = web

    companion object {
        const val HOST = "appassets.androidplatform.net"
        /** Opens the demo (PairActivity's "Try the demo"); ignored once a Mac is paired. */
        const val EXTRA_DEMO = "dev.ravenry.app.DEMO"
        const val ORIGIN = "https://$HOST"
    }
}

/**
 * Who may read the hub through `hub/<path>`: the page itself. Its requests
 * carry its own Referer (and its Origin, when they carry one); a frame of
 * another origin shows its own, or none when it hides it, and is refused
 * either way. (The spike in androidTest saw a no-cors fetch from another
 * origin arrive with no Origin header at all, so Origin alone is not enough.)
 */
object HubGate {
    fun allowed(headers: Map<String, String>?): Boolean {
        fun h(n: String) = headers?.entries?.firstOrNull { it.key.equals(n, true) }?.value
        val origin = h("Origin")
        if (origin != null && origin != MainActivity.ORIGIN) return false
        val referer = h("Referer") ?: return false
        return referer.startsWith(MainActivity.ORIGIN + "/")
    }

    fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** The part of a file a player asks for ("bytes=0-"), passed to the hub as it is; null when none. */
    fun range(headers: Map<String, String>?): String? =
        headers?.entries?.firstOrNull { it.key.equals("Range", true) }?.value?.trim()?.takeIf { Regex("^bytes=\\d*-\\d*$").matches(it) }
}

private const val STATE_URL = "ravenry.page"

/** The request headers the board's fetch may set on a hub request. */
private val PASS_HEADERS = setOf("content-type", "x-filename", "accept")
/** A cap on a body sent in parts, above the hub's 64 MB a file (POST /api/inbox, which src/board.ts checks first), so the cache never fills. */
private const val PARTS_MAX = 96L * 1024 * 1024
