package dev.ravenry.app

import okhttp3.Cache
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The board's files between reloads (HubClient `cache`, hub/server/static.mjs):
 * the hub sends them with an ETag and `no-cache`, so a reload asks again with
 * If-None-Match and a 304 gives the kept body; a file that changed comes at
 * once (never stale code); answers without an ETag (the API) are never kept.
 */
class BoardCacheTest {
    private val hub = HeldCertificate.Builder().commonName("Ravenry hub").ecdsa256().build()
    private lateinit var s: MockWebServer
    private val asked = CopyOnWriteArrayList<String>()
    @Volatile private var version = "one"
    private val dir = Files.createTempDirectory("board-files").toFile()
    private val cache = Cache(dir, 1L shl 20)

    @Before fun up() {
        s = MockWebServer()
        s.useHttps(HandshakeCertificates.Builder().heldCertificate(hub).build().sslSocketFactory(), false)
        s.protocols = listOf(okhttp3.Protocol.HTTP_1_1)
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val inm = request.getHeader("If-None-Match")
                asked.add("${request.path} ${inm ?: "-"}")
                if (request.path == "/api/state") return MockResponse().setHeader("Cache-Control", "no-store").setBody("{\"n\":${asked.size}}")
                val etag = "\"$version\""
                if (inm == etag) return MockResponse().setResponseCode(304).setHeader("ETag", etag).setHeader("Cache-Control", "no-cache")
                return MockResponse().setHeader("ETag", etag).setHeader("Cache-Control", "no-cache").setHeader("Content-Type", "text/javascript").setBody("code $version")
            }
        }
        s.start()
    }

    @After fun down() { s.shutdown(); cache.close(); dir.deleteRecursively() }

    private fun client() = HubClient(listOf("127.0.0.1"), s.port, Pins.of(hub.certificate), "tok", cache = cache)

    private fun get(c: HubClient, path: String): Pair<String, Int?> = c.execute("GET", path).use { r -> (r.body?.string() ?: "") to r.networkResponse?.code }

    @Test fun aReloadAsksAgainAndA304GivesTheKeptFile() {
        val c = client()
        assertEquals("code one" to 200, get(c, "/app.js"))
        // The reload: asked again with its ETag, answered 304, the body from the folder.
        assertEquals("code one" to 304, get(c, "/app.js"))
        assertEquals(listOf("/app.js -", "/app.js \"one\""), asked.toList())
    }

    @Test fun anUpdatedFileComesAtOnce() {
        val c = client()
        get(c, "/app.js"); get(c, "/app.js")
        version = "two"
        assertEquals("code two" to 200, get(c, "/app.js"))
        assertEquals("code two" to 304, get(c, "/app.js"))
    }

    @Test fun theApiIsNeverKept() {
        val c = client()
        val a = get(c, "/api/state").first
        val b = get(c, "/api/state").first
        assertEquals(listOf("/api/state -", "/api/state -"), asked.toList())
        assert(a != b)
        // Nothing of the API in the folder.
        val urls = cache.urls().asSequence().toList()
        assertNull(urls.firstOrNull { it.contains("/api/") })
    }
}
