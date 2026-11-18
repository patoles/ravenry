package dev.ravenry.app

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.security.cert.CertificateException

class PinTest {
    private val hub = HeldCertificate.Builder().commonName("Ravenry hub").ecdsa256().build()
    // A certificate a real authority signed, as far as a normal client can tell.
    private val authority = HeldCertificate.Builder().certificateAuthority(0).commonName("Some Public CA").ecdsa256().build()
    private val valid = HeldCertificate.Builder().signedBy(authority).addSubjectAlternativeName("localhost").commonName("localhost").ecdsa256().build()

    @Test fun acceptsOnlyThePinnedKey() {
        val t = PinnedTrust(Pins.of(hub.certificate))
        t.checkServerTrusted(arrayOf(hub.certificate), "ECDHE_ECDSA")
        try {
            t.checkServerTrusted(arrayOf(valid.certificate, authority.certificate), "ECDHE_ECDSA")
            fail("a certificate from an authority must not stand in for the pinned key")
        } catch (_: CertificateException) { }
    }

    @Test fun withNoPinItKeepsTheKeyItSaw() {
        val t = PinnedTrust(null)
        t.checkServerTrusted(arrayOf(hub.certificate), "ECDHE_ECDSA")
        assertEquals(Pins.of(hub.certificate), t.seen)
        assertEquals(43, t.seen!!.length)
    }

    private fun serve(cert: HeldCertificate, vararg chain: java.security.cert.X509Certificate): MockWebServer {
        val s = MockWebServer()
        s.useHttps(HandshakeCertificates.Builder().heldCertificate(cert, *chain).build().sslSocketFactory(), false)
        return s
    }

    @Test fun talksToThePinnedHubWithTheToken() {
        val s = serve(hub)
        s.enqueue(MockResponse().setBody("{\"ok\":true}"))
        s.start()
        val c = HubClient(listOf("127.0.0.1"), s.port, Pins.of(hub.certificate), "tok")
        val r = c.call("POST", "/api/send", "{}")
        assertEquals(200, r.status)
        val req = s.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("1", req.getHeader("X-Ravenry"))
        s.shutdown()
    }

    @Test fun refusesAnotherServerEvenWithAValidCertificate() {
        val s = serve(valid, authority.certificate)
        s.enqueue(MockResponse().setBody("{}"))
        s.start()
        val c = HubClient(listOf("localhost"), s.port, Pins.of(hub.certificate), "tok")
        try { c.call("GET", "/api/phone/me"); fail("must refuse") } catch (e: IOException) { assertNotNull(e) }
        assertEquals(0, s.requestCount)
        s.shutdown()
    }

    @Test fun triesTheNextAddressWhenOneIsDown() {
        val s = serve(hub)
        s.enqueue(MockResponse().setBody("{}"))
        s.start()
        var remembered: String? = null
        // 127.0.0.2 answers nothing on that port on most machines; 127.0.0.1 does.
        val c = HubClient(listOf("127.0.0.2", "127.0.0.1"), s.port, Pins.of(hub.certificate), "tok", onHost = { remembered = it })
        assertEquals(200, c.call("GET", "/api/phone/me").status)
        assertEquals("127.0.0.1", remembered)
        s.shutdown()
    }

    @Test fun aSignedOutAnswerSignsOut() {
        val s = serve(hub)
        s.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"Signed out.\",\"signedOut\":true}"))
        s.start()
        var out = false
        val c = HubClient(listOf("127.0.0.1"), s.port, Pins.of(hub.certificate), "tok", onSignedOut = { out = true })
        assertEquals(401, c.call("GET", "/api/phone/me").status)
        assertTrue(out)
        s.shutdown()
    }

    /** The id the Mac says on the Wi-Fi: the same vector as hub/tools/nearby-test.mjs and iOS's PinTests. */
    @Test fun theHubIdIsTheHubsOwn() {
        assertEquals("Yw3NKWbEM2aRElRI", Pins.hubId("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"))
        assertEquals(16, Pins.hubId(Pins.of(hub.certificate)).length)
    }
}
