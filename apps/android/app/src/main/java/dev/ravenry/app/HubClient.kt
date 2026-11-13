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
import java.util.concurrent.ConcurrentHashMap
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
 * computer's addresses in order: a home address (not a tailnet host) before
 * Tailscale, the one that answered last first within each, so at home the
 * phone goes straight to the Mac even with Tailscale on (docs/PHONE.md, The
 * connection). A home address gets [HOME_CONNECT_MS] to accept a connection
 * (a home network answers in tens of ms), and one that did not answer is
 * tried after Tailscale until it answers again or the network changes
 * ([networkChanged]), so away from home it costs requests nothing; the
 * connection watch's check ([probe], every 30 s) tries the home addresses
 * first every time, so coming home switches back within one check.
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
    /** A host only the tailnet reaches (Reach.tailnetHost); every other is a home one. */
    private val isTailnet: (String) -> Boolean = Reach::tailnetHost,
    homeConnectMs: Long = HOME_CONNECT_MS,
    /**
     * Where the board's own files are kept between reloads (the app's cache
     * folder; null: none). The hub sends them with an ETag and `no-cache`
     * (hub/server/static.mjs), so each reload asks "still this one?" and a
     * 304 costs a few hundred bytes; a changed file comes at once. Only
     * responses with an ETag are kept (the board's files, a brief's
     * pictures): never the API's answers.
     */
    private val cache: okhttp3.Cache? = null,
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
            .apply {
                if (cache != null) {
                    cache(cache)
                    addNetworkInterceptor { chain ->
                        val r = chain.proceed(chain.request())
                        if (r.header("ETag") == null) r.newBuilder().header("Cache-Control", "no-store").build() else r
                    }
                }
            }
            .build()
    }

    private val streaming: OkHttpClient = http.newBuilder().readTimeout(45, TimeUnit.SECONDS).build()
    private val quick: OkHttpClient = http.newBuilder().callTimeout(5, TimeUnit.SECONDS).build()
    // The same, with the home address's short time to connect.
    private val httpHome = http.newBuilder().connectTimeout(homeConnectMs, TimeUnit.MILLISECONDS).build()
    private val streamingHome = streaming.newBuilder().connectTimeout(homeConnectMs, TimeUnit.MILLISECONDS).build()
    private val quickHome = quick.newBuilder().connectTimeout(homeConnectMs, TimeUnit.MILLISECONDS).build()
    private fun pick(h: String, home: OkHttpClient, other: OkHttpClient) = if (isTailnet(h)) other else home

    /** Home addresses that did not answer, tried after Tailscale until they answer or the network changes. */
    private val homeDown: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** The phone's network changed (joined or left a Wi-Fi): every home address is worth a first try again. */
    fun networkChanged() = homeDown.clear()

    private fun answered(h: String) {
        homeDown.remove(h)
        if (h != host) { host = h; onHost(h) }
    }

    private fun failed(h: String) { if (!isTailnet(h)) homeDown.add(h) }

    /** A key that is not the pinned one: that address is not this computer (another device on a strange network may hold it). */
    private fun pinRefused(e: IOException) = e is javax.net.ssl.SSLPeerUnverifiedException || e.cause is CertificateException

    /**
     * How the Mac answers now: GET /api/phone/hello on the first address that
     * answers within 5 s, and the round trip in ms. Throws when none does.
     */
    fun probe(): Pair<String, Long> {
        val order = order(check = true)
        if (order.isEmpty()) throw IOException("No address can answer now")
        var last: IOException? = null
        var pin: IOException? = null
        for (h in order) {
            val t = System.nanoTime()
            try {
                pick(h, quickHome, quick).newCall(build(h, "GET", "/api/phone/hello", null, emptyMap())).execute().use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                }
                val ms = (System.nanoTime() - t) / 1_000_000
                answered(h)
                return h to ms
            } catch (e: IOException) {
                last = e
                failed(h)
                if (pinRefused(e)) pin = e
            }
        }
        throw pin ?: last ?: IOException("No address to try")
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

    /**
     * The hosts in the order they are tried now: the home addresses, then
     * the tailnet ones, the last that answered first within each; a home
     * address that did not answer goes after Tailscale (unless [check]: the
     * connection watch's check tries every home address first); those not
     * worth a try (Tailscale off) left out.
     */
    fun order(check: Boolean = false): List<String> {
        val (home, tail) = hosts.partition { !isTailnet(it) }
        val last = { l: List<String> -> if (host in l) listOf(host) + l.filter { it != host } else l }
        val h = last(home)
        val first = if (check) h else h.filter { it !in homeDown }
        return (first + last(tail) + (h - first.toSet())).filter { !skip(it) }
    }

    /** The host a stream opens on: the last that answered, unless it is not worth a try now. */
    private fun streamHost(): String = order().firstOrNull() ?: host

    /** Runs a request on the first address that answers. Throws when none does. */
    fun execute(method: String, path: String, body: RequestBody? = null, headers: Map<String, String> = emptyMap()): Response {
        val order = order()
        if (order.isEmpty()) throw IOException("No address can answer now")
        var last: IOException? = null
        var pin: IOException? = null
        for (h in order) {
            try {
                val r = pick(h, httpHome, http).newCall(build(h, method, path, body, headers)).execute()
                answered(h)
                if (r.code == 401) {
                    val peek = runCatching { r.peekBody(4096).string() }.getOrDefault("")
                    if (peek.contains("\"signedOut\":true")) onSignedOut()
                }
                return r
            } catch (e: IOException) {
                last = e
                failed(h)
                // A key that is not the pinned one: said when no other address answers.
                if (pinRefused(e)) pin = e
            }
        }
        throw pin ?: last ?: IOException("No address to try")
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
                var sh: String? = null
                try {
                    val h = streamHost().also { sh = it }
                    val c = pick(h, streamingHome, streaming).newCall(build(h, "GET", path, null, mapOf("Accept" to "text/event-stream")))
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
                    if (e is IOException) sh?.let(::failed)
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
        val h = streamHost()
        val b = build(h, "GET", path, null, if (protocol != null) mapOf("Sec-WebSocket-Protocol" to protocol) else emptyMap())
        return pick(h, httpHome, http).newWebSocket(b, listener)
    }

    companion object {
        val JSON = "application/json".toMediaType()

        /**
         * How long a home address gets to accept a connection. On a home
         * network the Mac accepts in tens of ms (Wi-Fi power save included);
         * away, an address that does not exist there either fails at once or
         * never answers, and this caps what the 30 s check spends on it.
         */
        const val HOME_CONNECT_MS = 1500L

        fun of(p: Paired, onHost: (String) -> Unit = {}, onSignedOut: () -> Unit = {}, skip: (String) -> Boolean = { false }, dns: okhttp3.Dns? = null, cache: okhttp3.Cache? = null): HubClient {
            val order = listOfNotNull(p.lastHost) + p.hosts
            return HubClient(order, p.port, p.pin, p.token, onHost, onSignedOut, skip, dns, cache = cache)
        }
    }
}
