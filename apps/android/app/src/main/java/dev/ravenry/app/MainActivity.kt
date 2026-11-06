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
                if (u.host == HOST && (u.path ?: "").startsWith("/phone/hub/")) {
                    // Only the page itself: a frame of another origin (an MCP
                    // App's sandbox) never reads the hub through this door.
                    if (request.method != "GET" || !HubGate.allowed(request.requestHeaders)) return HubGate.refused()
                    return hubResource(u)
                }
                return loader.shouldInterceptRequest(u)
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
        val was = savedInstanceState?.getString(STATE_URL)?.takeIf { it.startsWith("$ORIGIN/phone/index.html") && pending == null }
        web.loadUrl(was ?: "$ORIGIN/phone/index.html")
        if (Build.VERSION.SDK_INT >= 33 && !Store.get(this).notificationsAsked) {
            Store.get(this).notificationsAsked = true
            needPermission(Manifest.permission.POST_NOTIFICATIONS, {}, {})
        }
        Push.register(this)
        // Paired now (the first open after pairing too): hold the connection.
        ConnectionService.start(this)
    }

    private fun leave() {
        back.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        back.isEnabled = true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val a = intent.getStringExtra(Notifier.EXTRA_ALERT) ?: return
        if (out != null) event(JSONObject().put("event", "open").put("alert", parse(a))) else pending = a
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
                events?.close(); events = null
                if (o.optBoolean("on", true)) {
                    events = hub().events("/api/events", { name, data ->
                        event(JSONObject().put("event", "hub").put("name", name).put("data", parse(data)))
                    }, { up, err ->
                        event(JSONObject().put("event", "link").put("state", if (up) "up" else "down").put("error", err ?: JSONObject.NULL))
                    })
                }
                reply(id, true)
            }
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
                reply(id, true)
                Hub.io.execute {
                    runCatching { Hub.get(this)?.call("POST", "/api/phone/unpair", "{}") }
                    Push.unregister(this)
                    main.post {
                        Store.get(this).clear(); Hub.reset(); ConnectionService.stop(this)
                        startActivity(Intent(this, PairActivity::class.java))
                        finish()
                    }
                }
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

    /** A picture or file of the hub: `hub/<path>` relative to the page, fetched with the pin and the token. */
    private fun hubResource(u: Uri): WebResourceResponse {
        val path = "/" + (u.encodedPath ?: "").removePrefix("/phone/hub/") + (u.encodedQuery?.let { "?$it" } ?: "")
        return try {
            val r = hub().execute("GET", path)
            val type = r.header("Content-Type")?.substringBefore(';')?.trim() ?: "application/octet-stream"
            val bytes = r.body?.bytes() ?: ByteArray(0)
            r.close()
            WebResourceResponse(type, null, r.code, r.message.ifEmpty { "OK" }, mapOf("Cache-Control" to "no-cache"), ByteArrayInputStream(bytes))
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

    private fun unreachable(e: Throwable): String {
        val name = Store.get(this).paired()?.hubName ?: "The computer"
        return if (e is java.io.IOException) "$name didn't answer. Is it on, and is this phone on its Wi-Fi or Tailscale?" else (e.message ?: "It did not work.")
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
