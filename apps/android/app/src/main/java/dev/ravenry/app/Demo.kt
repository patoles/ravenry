package dev.ravenry.app

import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference

/**
 * The demo (docs/PHONE.md, The demo): the board on sample projects for a
 * phone with no Mac yet, from "No Mac yet? Try the demo" on the pairing
 * screen, never once a Mac is paired. The page answers the board itself
 * (apps/phone/src/demo.ts); here the shell serves only the app's own files:
 * the board's page as the hub has it (assets phone/board, built from
 * hub/public with the app) and the recording's pictures (phone/demo). No
 * connection is made: nothing here opens a socket, and the shell's hub
 * requests are refused in the demo (MainActivity).
 */
object Demo {
    /** An alert of the demo's: its id starts so, and its buttons answer the demo's card, never a hub. */
    const val PREFIX = "demo:"

    /** The ops that would reach a hub: refused in the demo (the page never sends them). */
    val HUB_OPS = setOf("http", "http.part", "hub.call", "hub.events", "socket.open", "socket.send", "socket.close", "reach.retry", "conn.reconnect",
        "photo", "voice.start", "voice.stop", "voice.cancel", "secret.open", "secret.move", "secret.send", "secret.close", "push.set", "connection.set", "speech", "open.tailscale", "pair.again")

    /** The policy of the demo's board page: its own files only, never another origin. */
    private const val CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
        "connect-src 'self'; media-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

    /** The demo's screen, while it is open: the alert's buttons answer its card there. */
    @Volatile private var screen: WeakReference<MainActivity>? = null
    fun attach(a: MainActivity?) { screen = a?.let { WeakReference(it) } }

    /** How many of the app's files the demo served, for the check (logcat). */
    @Volatile var served = 0; private set

    private fun type(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"; "js", "mjs" -> "text/javascript"; "css" -> "text/css"; "svg" -> "image/svg+xml"
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"; "json" -> "application/json"; "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    private fun response(type: String, bytes: ByteArray, status: Int = 200, headers: Map<String, String> = emptyMap()): WebResourceResponse {
        served++
        return WebResourceResponse(type, if (type.startsWith("text/") || type.endsWith("json")) "utf-8" else null, status, if (status == 200) "OK" else "Not Found",
            mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff") + headers, ByteArrayInputStream(bytes))
    }

    private fun missing() = response("text/plain", ByteArray(0), 404)

    private fun asset(c: Context, path: String): ByteArray? =
        if (path.contains("..")) null else runCatching { c.assets.open(path).use { it.readBytes() } }.getOrNull()

    private var files: JSONObject? = null
    private fun files(c: Context): JSONObject = files ?: (asset(c, "phone/demo/files.json")?.let { runCatching { JSONObject(String(it)) }.getOrNull() } ?: JSONObject()).also { files = it }

    /** A recorded hub path's key, as the recording has it: the cache-busting `v` left out (apps/phone/src/demo.ts keyOf). */
    fun keyOf(path: String, query: String?): String {
        val q = (query ?: "").split('&').filter { it.isNotEmpty() && !it.startsWith("v=") }.joinToString("&")
        return if (q.isEmpty()) path else "$path?$q"
    }

    /**
     * A request of the demo's page for the hub's side of the origin: the
     * board's page (with the app's layer first, marked as the demo's), its
     * files, the recording's pictures; anything else is not there.
     */
    fun resource(c: Context, u: Uri, method: String): WebResourceResponse {
        if (method != "GET") return missing()
        val raw = u.encodedPath ?: "/"
        val path = if (raw.startsWith("/phone/hub/")) raw.removePrefix("/phone/hub") else raw
        if (path == "/" || path == "/index.html") {
            val html = asset(c, "phone/board/index.html")?.let { String(it) } ?: return missing()
            val page = html.replaceFirst("<head>", "<head>\n<script src=\"/phone/board.js\" data-demo></script>")
            return response("text/html", page.toByteArray(), headers = mapOf("Content-Security-Policy" to CSP))
        }
        if (path.startsWith("/api/")) {
            val f = files(c).optJSONObject(keyOf(path, u.encodedQuery)) ?: return missing()
            val name = f.str("file") ?: return missing()
            return asset(c, "phone/demo/$name")?.let { response(f.str("type") ?: type(name), it) } ?: missing()
        }
        return asset(c, "phone/board" + path)?.let { response(type(path), it) } ?: missing()
    }

    /** The question's alert, posted by the phone itself (the page's `demo.alert`), when Android shows Ravenry's alerts. */
    fun post(c: Context, json: String): Boolean {
        val a = Alert.parse(json) ?: return false
        if (!a.id.startsWith(PREFIX) || !Notifier.allowed(c)) return false
        Notifier.show(c, a)
        return true
    }

    /** A button of the demo's alert: the demo's card answered on its screen, "Sent: ..." in the shade; nothing leaves the phone. */
    fun action(c: Context, a: Alert, id: String) {
        val n = Regex("^choice:(\\d+)$").find(id)?.groupValues?.get(1)?.toIntOrNull()
        val s = screen?.get()
        if (n == null || a.checkpointId == null || s == null || s.isFinishing) { Notifier.cancel(c, a.id); return }
        s.demoAnswer(a.checkpointId, JSONObject().put("choice", n))
        val label = a.actions.firstOrNull { it.id == id }?.label ?: id
        Notifier.after(c, a, true, c.getString(R.string.sent, label))
    }

    /** Every alert of the demo's taken off the shade (leaving the demo). */
    fun clearAlerts(c: Context) {
        runCatching { c.getSystemService(NotificationManager::class.java).activeNotifications.filter { it.tag?.startsWith(PREFIX) == true }.forEach { Notifier.cancel(c, it.tag) } }
    }
}
