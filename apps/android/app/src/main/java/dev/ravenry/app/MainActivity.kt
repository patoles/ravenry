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
        if (Store.get(this).paired() == null) {
            startActivity(Intent(this, PairActivity::class.java))
            finish(); return
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        box = FrameLayout(this)
        web = WebView(this)
        box.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(box)
        ink = InkLaunch.begin(this, box, web, retry = { conn.reconnect() }, why = { Hub.get(this)?.let { reachOf(it.allHosts, null).words } ?: getString(R.string.mac_no_answer) })
        ViewCompat.setOnApplyWindowInsetsListener(box) { v, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, box).isAppearanceLightStatusBars = !night
        WindowCompat.getInsetsController(window, box).isAppearanceLightNavigationBars = !night

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
                if (path.startsWith("/phone/hub/")) {
                    // Only the page itself: a frame of another origin (an MCP
                    // App's sandbox) never reads the hub through this door.
                    if (request.method != "GET" || !HubGate.allowed(request.requestHeaders)) return HubGate.refused()
                    return hubResource(u)
                }
                if (path.startsWith("/phone/")) return loader.shouldInterceptRequest(u)
                // The rest of the origin is the hub's own board, the app's
                // home (docs/PHONE.md section 1): its page, opened in this
                // WebView, and its files and pictures for that page only.
                if (request.method != "GET") return HubGate.refused()
                if (request.isForMainFrame) return boardPage(u)
                if (!HubGate.allowed(request.requestHeaders)) return HubGate.refused()
                return hubResource(u, board = true)
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
        if (Build.VERSION.SDK_INT >= 33 && !Store.get(this).notificationsAsked) {
            Store.get(this).notificationsAsked = true
            needPermission(Manifest.permission.POST_NOTIFICATIONS, {}, {})
        }
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
        if (!moveTaskToBack(true)) {
            back.isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            back.isEnabled = true
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val a = intent.getStringExtra(Notifier.EXTRA_ALERT) ?: return
        if (out != null) event(JSONObject().put("event", "open").put("alert", parse(a))) else pending = a
    }

    override fun onStart() {
        super.onStart()
        if (::web.isInitialized) conn.start()
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
        val op = o.optString("op")
        if (o.optInt("v", 1) != 1) { reply(id, false, error = "This app speaks bridge version 1."); return }
        try {
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
                    .put("hub", JSONObject().put("name", p?.hubName).put("port", p?.port))
                    .put("device", JSONObject().put("id", p?.deviceId).put("name", p?.deviceName))
                    .put("features", JSONArray(features()))
                    .put("pending", pending?.let { parse(it) } ?: JSONObject.NULL)
                pending = null
                reply(id, true, r)
            }
            // A request of the board's page (src/board.ts's fetch): any
            // method, its body and headers as they are, the answer's bytes.
            "http" -> {
                val method = o.optString("method", "GET").uppercase()
                val path = o.optString("path")
                if (!path.startsWith("/")) { reply(id, false, error = "A path starts with /."); return }
                val bytes = o.optString("b64").takeIf { it.isNotEmpty() && it != "null" }?.let { Base64.getDecoder().decode(it) }
                val hs = o.optJSONObject("headers")
                val headers = mutableMapOf<String, String>()
                hs?.keys()?.forEach { k -> if (k.lowercase() in PASS_HEADERS) headers[k] = hs.optString(k) }
                Hub.io.execute {
                    try {
                        val type = headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value
                        val body = if (method == "GET" || method == "HEAD") null else (bytes ?: ByteArray(0)).toRequestBody(type?.toMediaTypeOrNull())
                        hub().execute(method, path, body, headers).use { r ->
                            val out = r.body?.bytes() ?: ByteArray(0)
                            reply(id, true, JSONObject().put("status", r.code).put("type", r.header("Content-Type") ?: "application/octet-stream").put("b64", Base64.getEncoder().encodeToString(out)))
                        }
                    } catch (e: Exception) {
                        reply(id, false, error = unreachable(e))
                    }
                }
            }
            "reach.now" -> reply(id, true, lastReach ?: JSONObject.NULL)
            "reach.retry" -> { lastReach = null; Hub.io.execute { runCatching { hub().call("GET", "/api/phone/hello") }.onSuccess { main.post { web.reload() } }.onFailure { unreachable(it) } }; reply(id, true) }
            // The board's background and theme for the system bars (src/board.ts).
            "bars" -> {
                val light = o.optBoolean("light", false)
                val c = Regex("""rgba?\((\d+),\s*(\d+),\s*(\d+)""").find(o.optString("color"))?.groupValues
                main.post {
                    if (c != null) box.setBackgroundColor(android.graphics.Color.rgb(c[1].toInt(), c[2].toInt(), c[3].toInt()))
                    WindowCompat.getInsetsController(window, box).isAppearanceLightStatusBars = light
                    WindowCompat.getInsetsController(window, box).isAppearanceLightNavigationBars = light
                }
                reply(id, true)
            }
            "open.tailscale" -> { Reach.openTailscale(this); reply(id, true) }
            "hub.call" -> {
                val method = o.optString("method", "GET")
                val path = o.optString("path")
                if (!path.startsWith("/")) { reply(id, false, error = "A path starts with /."); return }
                val b = o.opt("body")
                val json = when (b) { null, JSONObject.NULL -> null; is String -> b; else -> b.toString() }
                Hub.io.execute {
                    try {
                        val r = hub().call(method, path, json)
                        reply(id, true, JSONObject().put("status", r.status).put("body", if (r.text.isEmpty()) JSONObject.NULL else parse(r.text)))
                    } catch (e: Exception) {
                        reply(id, false, error = unreachable(e))
                    }
                }
            }
            "hub.events" -> {
                eventsWanted = o.optBoolean("on", true)
                startEvents()
                reply(id, true)
            }
            "conn.now" -> reply(id, true, conn.json())
            "conn.reconnect" -> { conn.reconnect(); reply(id, true) }
            "ink.ready" -> { ink?.ready(o); reply(id, true) }
            "socket.open" -> {
                val sid = nextSid.getAndIncrement()
                val path = o.optString("path")
                val proto = o.optString("protocol").takeIf { it.isNotEmpty() }
                Hub.io.execute {
                    try {
                        val ws = hub().socket(path, proto, object : WebSocketListener() {
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
                val ok = if (o.has("b64")) ws.send(Base64.getDecoder().decode(o.getString("b64")).toByteString()) else ws.send(o.optString("text"))
                if (ok) reply(id, true) else reply(id, false, error = "That connection is closed.")
            }
            "socket.close" -> { sockets.remove(o.optInt("sid"))?.close(1000, null); reply(id, true) }
            "biometric" -> Biometrics.ask(this, o.optString("title", getString(R.string.run)), o.optString("subtitle").takeIf { it.isNotEmpty() }) { ok, err ->
                if (ok) reply(id, true, JSONObject().put("ok", true)) else reply(id, false, error = err ?: "Not confirmed.")
            }
            "photo" -> {
                val project = o.optString("projectId").takeIf { it.isNotEmpty() } ?: run { reply(id, false, error = "Which session's project?"); return }
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
                val project = o.optString("projectId").takeIf { it.isNotEmpty() }
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
                val cp = o.optString("checkpoint").takeIf { it.isNotEmpty() } ?: run { reply(id, false, error = "Which checkpoint?"); return }
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
            "alerts.clear" -> { Notifier.cancel(this, o.optString("id")); reply(id, true) }
            "pair.reset" -> {
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
                ?: runCatching { JSONObject(r.getOrThrow().text).optString("error") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: "It was not sent."
            main.post {
                if (ok) closeSecret()
                if (id != null) { if (ok) reply(id, true, JSONObject().put("ok", true)) else reply(id, false, error = err) }
                event(JSONObject().put("event", "secret.done").put("ok", ok).put("error", err ?: JSONObject.NULL))
            }
        }
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
            if (r.status != 200) { reply(id, false, error = b.optString("error").ifEmpty { "It was not sent." }); return }
            val res = JSONObject().put("path", b.optString("path")).put("short", b.optString("short")).put("name", f.name)
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
    private fun hubResource(u: Uri, board: Boolean = false): WebResourceResponse {
        val path = (if (board) (u.encodedPath ?: "/") else "/" + (u.encodedPath ?: "").removePrefix("/phone/hub/")) + (u.encodedQuery?.let { "?$it" } ?: "")
        return try {
            val r = hub().execute("GET", path)
            val type = r.header("Content-Type")?.substringBefore(';')?.trim() ?: "application/octet-stream"
            val bytes = r.body?.bytes() ?: ByteArray(0)
            r.close()
            // The hub's own policy goes with it: a pick's HTML or SVG variant
            // comes with `Content-Security-Policy: sandbox`, so it never runs
            // as the page, whatever frame shows it.
            val headers = mutableMapOf("Cache-Control" to "no-cache", "X-Content-Type-Options" to "nosniff")
            r.header("Content-Security-Policy")?.let { headers["Content-Security-Policy"] = it }
            WebResourceResponse(type, null, r.code, r.message.ifEmpty { "OK" }, headers, ByteArrayInputStream(bytes))
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    private fun features(): List<String> {
        val f = mutableListOf("secret")
        if (runCatching { UnifiedPush.getDistributors(this).isNotEmpty() }.getOrDefault(false)) f += "push"
        val bio = BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        if (bio != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE && bio != BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) f += "biometric"
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
            if (up) lastReach = null
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
                .put("reason", if (state == "offline") r?.optString("reason") ?: JSONObject.NULL else JSONObject.NULL)
                .put("words", if (state == "offline") r?.optString("words") ?: JSONObject.NULL else JSONObject.NULL)
                .put("mac", Store.get(this@MainActivity).paired()?.hubName ?: JSONObject.NULL)
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
            lastReach = null
            Hub.reset()
            set("reconnecting")
            if (eventsWanted) startEvents()
            probe()
        }

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
                        lastReach = null
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
                            lastReach?.let { rr -> event(JSONObject(rr.toString()).put("event", "reach")); ink?.unreached(rr.optString("words")) }
                        } else if (state != "offline") set("reconnecting")
                        schedule(3000)
                    })
                }
            }
        }
    }

    /** The last reason the computer could not be reached, for the board's bar (null once it answers). */
    @Volatile private var lastReach: JSONObject? = null

    private fun reachOf(hosts: List<String>, e: Throwable?): Reach.Why {
        val w = Reach.why(this, hosts, e)
        lastReach = JSONObject().put("reason", w.reason).put("words", w.words)
        return w
    }

    /** What a failed request says: why the computer cannot be reached, never a host name. */
    private fun unreachable(e: Throwable): String {
        if (e !is java.io.IOException) return e.message ?: "It did not work."
        val w = reachOf(Hub.get(this)?.allHosts ?: emptyList(), e)
        lastReach?.let { r -> event(JSONObject(r.toString()).put("event", "reach")) }
        return w.words
    }

    private fun stamp() = SimpleDateFormat("HHmm-ss", Locale.US).format(Date())

    /** For the instrumented tests: the page's WebView. */
    @androidx.annotation.VisibleForTesting
    fun webView(): WebView = web

    companion object {
        const val HOST = "appassets.androidplatform.net"
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
}

private const val STATE_URL = "ravenry.page"

/** The request headers the board's fetch may set on a hub request. */
private val PASS_HEADERS = setOf("content-type", "x-filename", "accept")
