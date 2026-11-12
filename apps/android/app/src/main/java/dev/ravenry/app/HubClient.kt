package dev.ravenry.app

import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.Closeable
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Trusts exactly one key: the pinned one (docs/PHONE.md section 2). Any
 * other certificate is refused, whoever signed it, a public authority
 * included. With no pin yet (a typed pairing) it takes whatever key the
 * server shows and keeps it in [seen], for the person to compare.
 */
class PinnedTrust(private val pin: String?) : X509TrustManager {
    @Volatile var seen: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("No certificate")
        val p = Pins.of(leaf)
        seen = p
        if (pin != null && p != pin) throw CertificateException("This is not the paired computer's key")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Not a server")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class HubReply(val status: Int, val text: String)

/**
 * Every byte between the phone and the hub: TLS with the pinned key, the
 * device token on every request, `X-Ravenry: 1` on every write. Tries the
 * computer's addresses in order, the last one that answered first.
 */
class HubClient(
    hosts: List<String>,
    private val port: Int,
    pin: String?,
    private val token: String?,
    private val onHost: (String) -> Unit = {},
    private val onSignedOut: () -> Unit = {},
    /** Hosts not worth a try now (a tailnet one with no VPN up: Reach.skip). */
    private val skip: (String) -> Boolean = { false },
    /** Names resolved another way (a debug build's stand-in tailnet name: DebugNet). */
    private val dns: okhttp3.Dns? = null,
) {
    val trust = PinnedTrust(pin)
    private val hosts = hosts.distinct()
    /** Every address of the computer, for the words when none answers (Reach). */
    val allHosts: List<String> get() = hosts
    @Volatile var host: String = this.hosts.first()
        private set

    val http: OkHttpClient = run {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(trust), SecureRandom())
        OkHttpClient.Builder()
            .sslSocketFactory(ctx.socketFactory, trust)
            // The key is the computer's identity, not a name: an address on
            // the Wi-Fi or Tailscale has no certificate name to check.
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .apply { if (dns != null) dns(dns) }
            .build()
    }

    private val streaming: OkHttpClient = http.newBuilder().readTimeout(45, TimeUnit.SECONDS).build()
    private val quick: OkHttpClient = http.newBuilder().callTimeout(5, TimeUnit.SECONDS).build()

    /**
     * How the Mac answers now: GET /api/phone/hello on the first address that
     * answers within 5 s, and the round trip in ms. Throws when none does.
     */
    fun probe(): Pair<String, Long> {
        val order = order()
        if (order.isEmpty()) throw IOException("No address can answer now")
        var last: IOException? = null
        for (h in order) {
            val t = System.nanoTime()
            try {
                quick.newCall(build(h, "GET", "/api/phone/hello", null, emptyMap())).execute().use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                }
                val ms = (System.nanoTime() - t) / 1_000_000
                if (h != host) { host = h; onHost(h) }
                return h to ms
            } catch (e: IOException) {
                last = e
                if (e is javax.net.ssl.SSLPeerUnverifiedException || e.cause is CertificateException) throw e
            }
        }
        throw last ?: IOException("No address to try")
    }

    fun url(h: String, path: String): String {
        val hh = if (h.contains(':') && !h.startsWith("[")) "[$h]" else h
        return "https://$hh:$port$path"
    }

    private fun build(h: String, method: String, path: String, body: RequestBody?, headers: Map<String, String>): Request {
        val b = Request.Builder().url(url(h, path))
        if (token != null) b.header("Authorization", "Bearer $token")
        if (method != "GET") b.header("X-Ravenry", "1")
        headers.forEach { (k, v) -> b.header(k, v) }
        val m = method.uppercase()
        b.method(m, if (m == "GET" || m == "HEAD") null else body ?: ByteArray(0).toRequestBody(null))
        return b.build()
    }

    /** The hosts in the order they are tried now: the last that answered first, those not worth a try left out. */
    fun order(): List<String> = (listOf(host) + hosts.filter { it != host }).filter { !skip(it) }

    /** The host a stream opens on: the last that answered, unless it is not worth a try now. */
    private fun streamHost(): String = order().firstOrNull() ?: host

    /** Runs a request on the first address that answers. Throws when none does. */
    fun execute(method: String, path: String, body: RequestBody? = null, headers: Map<String, String> = emptyMap()): Response {
        val order = order()
        if (order.isEmpty()) throw IOException("No address can answer now")
        var last: IOException? = null
        for (h in order) {
            try {
                val r = http.newCall(build(h, method, path, body, headers)).execute()
                if (h != host) { host = h; onHost(h) }
                if (r.code == 401) {
                    val peek = runCatching { r.peekBody(4096).string() }.getOrDefault("")
                    if (peek.contains("\"signedOut\":true")) onSignedOut()
                }
                return r
            } catch (e: IOException) {
                last = e
                // A key that is not the pinned one is not a host that is down.
                if (e is javax.net.ssl.SSLPeerUnverifiedException || e.cause is CertificateException) throw e
            }
        }
        throw last ?: IOException("No address to try")
    }

    /** A JSON call: `body` is JSON text or null. */
    fun call(method: String, path: String, json: String? = null): HubReply {
        val body = json?.toRequestBody(JSON)
        execute(method, path, body, if (json != null) mapOf("Content-Type" to "application/json") else emptyMap()).use {
            return HubReply(it.code, it.body?.string() ?: "")
        }
    }

    fun upload(path: String, bytes: ByteArray, filename: String, type: String): HubReply {
        execute("POST", path, bytes.toRequestBody(type.toMediaType()), mapOf("x-filename" to filename)).use {
            return HubReply(it.code, it.body?.string() ?: "")
        }
    }

    /**
     * Server-sent events (GET /api/events): each `event:` with its `data:`.
     * Reconnects after a drop until closed; `link` says up or down.
     */
    fun events(path: String, onEvent: (String, String) -> Unit, link: (Boolean, String?) -> Unit): Closeable {
        val holder = object : Closeable {
            @Volatile var closed = false
            @Volatile var call: Call? = null
            override fun close() { closed = true; call?.cancel() }
        }
        Thread({
            var wait = 1000L
            while (!holder.closed) {
                try {
                    val c = streaming.newCall(build(streamHost(), "GET", path, null, mapOf("Accept" to "text/event-stream")))
                    holder.call = c
                    c.execute().use { r ->
                        if (r.code == 401) { onSignedOut(); holder.closed = true; link(false, "signed out"); return@use }
                        if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                        link(true, null)
                        wait = 1000L
                        val src = r.body!!.source()
                        var name = "message"
                        val data = StringBuilder()
                        while (!holder.closed) {
                            val line = src.readUtf8Line() ?: break
                            when {
                                line.isEmpty() -> {
                                    if (data.isNotEmpty()) onEvent(name, data.toString())
                                    name = "message"; data.setLength(0)
                                }
                                line.startsWith(":") -> Unit
                                line.startsWith("event:") -> name = line.substring(6).trim()
                                line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.substring(5).removePrefix(" ")) }
                            }
                        }
                    }
                    if (!holder.closed) link(false, "the stream ended")
                } catch (e: Exception) {
                    if (holder.closed) break
                    link(false, e.message)
                    // Another address may answer now (the Wi-Fi went, Tailscale is up).
                    runCatching { call("GET", "/api/phone/hello") }
                }
                if (!holder.closed) { Thread.sleep(wait); wait = (wait * 2).coerceAtMost(15000L) }
            }
        }, "ravenry-events").apply { isDaemon = true }.start()
        return holder
    }

    fun socket(path: String, protocol: String?, listener: WebSocketListener): WebSocket {
        val b = build(streamHost(), "GET", path, null, if (protocol != null) mapOf("Sec-WebSocket-Protocol" to protocol) else emptyMap())
        return http.newWebSocket(b, listener)
    }

    companion object {
        val JSON = "application/json".toMediaType()

        fun of(p: Paired, onHost: (String) -> Unit = {}, onSignedOut: () -> Unit = {}, skip: (String) -> Boolean = { false }, dns: okhttp3.Dns? = null): HubClient {
            val order = listOfNotNull(p.lastHost) + p.hosts
            return HubClient(order, p.port, p.pin, p.token, onHost, onSignedOut, skip, dns)
        }
    }
}
