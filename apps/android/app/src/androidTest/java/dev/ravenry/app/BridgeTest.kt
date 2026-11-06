package dev.ravenry.app

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The page and the shell, round trip, against a hub with a pinned self-signed key. */
@RunWith(AndroidJUnit4::class)
class BridgeTest {
    private val cert = HeldCertificate.Builder().commonName("Ravenry hub").ecdsa256().build()
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before fun up() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                return when (request.path) {
                    "/api/phone/me" -> MockResponse().setBody("""{"device":{"id":"d1","name":"Test phone"},"hub":{"name":"Test Mac","api":1},"access":true}""")
                    "/api/send" -> MockResponse().setBody("""{"ok":true,"delivered":"now"}""")
                    "/api/events" -> MockResponse().setBody("event: state\ndata: {\"projects\":[]}\n\n").setHeader("Content-Type", "text/event-stream")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"unknown"}""")
                }
            }
        }
        server.start()
        Store.get(ctx).save(Paired("Test Mac", listOf("127.0.0.1"), server.port, Pins.of(cert.certificate), "test-token", "d1", "Test phone"))
        Hub.reset()
    }

    @After fun down() {
        Store.get(ctx).clear(); Hub.reset(); ConnectionService.stop(ctx)
        server.shutdown()
    }

    /** Sends one bridge message from the page and returns the shell's reply. */
    private fun ask(web: WebView, message: String): JSONObject {
        val js = """
          (function(){ window.__r = null; const s = window.ravenryShell; if (!s) { window.__r = 'no bridge'; return; }
            s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 991) window.__r = e.data; };
            s.postMessage(JSON.stringify($message)); })();
        """.trimIndent()
        val done = CountDownLatch(1)
        var out: String? = null
        val inst = InstrumentationRegistry.getInstrumentation()
        inst.runOnMainSync { web.evaluateJavascript(js, null) }
        val until = System.currentTimeMillis() + 15000
        while (out == null && System.currentTimeMillis() < until) {
            val l = CountDownLatch(1)
            inst.runOnMainSync { web.evaluateJavascript("window.__r") { v -> val s = JSONTokener(v).nextValue(); if (s is String) out = s; l.countDown() } }
            l.await(2, TimeUnit.SECONDS)
            if (out == null) Thread.sleep(200)
        }
        done.countDown()
        return JSONObject(out ?: error("no reply"))
    }

    @Test fun helloAndAHubCallGoThroughTheShell() {
        ActivityScenario.launch(MainActivity::class.java).use { sc ->
            var web: WebView? = null
            sc.onActivity { web = it.webView() }
            // Let the page load.
            Thread.sleep(2500)
            val hello = ask(web!!, """{"v":1,"id":991,"op":"hello"}""")
            assertTrue(hello.toString(), hello.getBoolean("ok"))
            val r = hello.getJSONObject("result")
            assertEquals("android", r.getString("platform"))
            assertEquals("Test Mac", r.getJSONObject("hub").getString("name"))
            assertEquals("d1", r.getJSONObject("device").getString("id"))

            val call = ask(web!!, """{"v":1,"id":991,"op":"hub.call","method":"POST","path":"/api/send","body":{"projectId":"p","surfaceId":"s","text":"hi"}}""")
            assertTrue(call.toString(), call.getBoolean("ok"))
            assertEquals(200, call.getJSONObject("result").getInt("status"))
            assertEquals("now", call.getJSONObject("result").getJSONObject("body").getString("delivered"))
            val sent = seen.first { it.path == "/api/send" }
            assertEquals("Bearer test-token", sent.getHeader("Authorization"))
            assertEquals("1", sent.getHeader("X-Ravenry"))
            assertEquals("hi", JSONObject(sent.body.readUtf8()).getString("text"))

            val bad = ask(web!!, """{"v":1,"id":991,"op":"no.such.op"}""")
            assertEquals(false, bad.getBoolean("ok"))
        }
    }
}
