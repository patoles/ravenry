package dev.ravenry.app

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Home Wi-Fi first (docs/PHONE.md, The connection): with both a home address
 * and Tailscale answering the phone goes through the home address, whichever
 * answered last; Tailscale only when no home address answers; a home address
 * that does not answer costs the next requests nothing; the 30 s check tries
 * home first every time, so coming home switches back.
 */
class HubOrderTest {
    private val home = "studio.home.arpa"
    private val tail = "ravenry.tail0000.ts.net"
    private val hub = HeldCertificate.Builder().commonName("Ravenry hub").ecdsa256().build()
    private lateinit var s: MockWebServer
    /** The Host each request came to: one server answers for both names, as the Mac does. */
    private val seen = CopyOnWriteArrayList<String>()
    /** Where each name goes now: 127.0.0.1 (answers), a black hole (never answers), or nowhere. */
    private val where = ConcurrentHashMap<String, String>()
    private val dns = object : okhttp3.Dns {
        override fun lookup(hostname: String): List<InetAddress> = when (val a = where[hostname]) {
            null, "" -> throw UnknownHostException(hostname)
            else -> listOf(InetAddress.getByName(a))
        }
    }

    @Before fun up() {
        s = MockWebServer()
        s.useHttps(HandshakeCertificates.Builder().heldCertificate(hub).build().sslSocketFactory(), false)
        s.protocols = listOf(okhttp3.Protocol.HTTP_1_1)
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen.add((request.getHeader(":authority") ?: request.getHeader("Host") ?: "?").substringBefore(':'))
                return MockResponse().setBody("{\"ok\":true}")
            }
        }
        s.start()
        where[home] = "127.0.0.1"
        where[tail] = "127.0.0.1"
    }

    @After fun down() { s.shutdown() }

    private fun client(hosts: List<String>, connectMs: Long = 300) =
        HubClient(hosts, s.port, Pins.of(hub.certificate), "tok", dns = dns, homeConnectMs = connectMs)

    /** A home address that stopped answering: no route to it (and its open connections gone, as when the Wi-Fi goes). */
    private fun homeGone(c: HubClient, blackHole: Boolean) {
        where[home] = if (blackHole) "10.255.255.1" else ""
        c.http.connectionPool.evictAll()
    }

    private fun timed(f: () -> Unit): Long { val t = System.nanoTime(); f(); return (System.nanoTime() - t) / 1_000_000 }

    @Test fun theOrderIsHomeThenTailscaleTheLastThatAnsweredFirstWithinEach() {
        // Paired away from home: the tailnet name answered last.
        val c = HubClient(listOf(tail, "100.64.0.2", "192.168.1.36", "10.0.0.5"), 4601, null, null)
        assertEquals(listOf("192.168.1.36", "10.0.0.5", tail, "100.64.0.2"), c.order())
        assertEquals(c.order(), c.order(check = true))
        // The second home address answered last: it goes first among the home ones.
        val d = HubClient(listOf("10.0.0.5", "192.168.1.36", tail), 4601, null, null)
        assertEquals(listOf("10.0.0.5", "192.168.1.36", tail), d.order())
        // Tailscale off: the tailnet hosts are left out, the home ones stay.
        val e = HubClient(listOf(tail, "192.168.1.36"), 4601, null, null, skip = { Reach.tailnetHost(it) })
        assertEquals(listOf("192.168.1.36"), e.order())
    }

    @Test fun bothAnswerAndTheLastWasTailscale_itGoesHome() {
        var remembered: String? = null
        val c = HubClient(listOf(tail, home), s.port, Pins.of(hub.certificate), "tok", onHost = { remembered = it }, dns = dns)
        assertEquals(200, c.call("GET", "/api/phone/me").status)
        assertEquals(listOf(home), seen)
        assertEquals(home, c.host)
        assertEquals(home, remembered)
        assertEquals("wifi", Reach.via(c.host, c.allHosts))
        assertEquals(home, c.probe().first)
    }

    @Test fun homeDoesNotAnswer_tailscale_andTheNextRequestsDoNotWaitOnHome() {
        val c = client(listOf(home, tail), connectMs = 300)
        c.call("GET", "/api/phone/me")
        homeGone(c, blackHole = true)
        seen.clear()
        val first = timed { assertEquals(200, c.call("GET", "/api/phone/me").status) }
        assertEquals(tail, c.host)
        // The home try is capped by its time to connect (300 ms here, 1500 in the app).
        assertTrue("first request $first ms", first < 300 + 700)
        val next = (1..5).map { timed { c.call("GET", "/api/phone/me") } }
        println("home a black hole: first request $first ms (through Tailscale), next $next ms")
        assertTrue("next requests $next ms", next.all { it < 250 })
        assertEquals(List(6) { tail }, seen)
        assertEquals(listOf(tail, home), c.order())
    }

    @Test fun theCheckTriesHomeFirstEveryTime_comingHomeSwitchesBack_leavingSwitchesToTailscale() {
        val c = client(listOf(home, tail))
        assertEquals(home, c.probe().first)
        // Leaving: the next check goes through Tailscale.
        homeGone(c, blackHole = false)
        assertEquals(tail, c.probe().first)
        assertEquals("tailscale", Reach.via(c.host, c.allHosts))
        assertEquals(tail, c.probe().first)
        // Requests meanwhile stay on Tailscale.
        seen.clear(); c.call("GET", "/api/phone/me"); assertEquals(listOf(tail), seen)
        // Coming home: within one check, home again, and the requests follow.
        where[home] = "127.0.0.1"
        assertEquals(home, c.probe().first)
        assertEquals("wifi", Reach.via(c.host, c.allHosts))
        seen.clear(); c.call("GET", "/api/phone/me"); assertEquals(listOf(home), seen)
    }

    @Test fun aNetworkChangeGivesHomeTheFirstTryAgain() {
        val c = client(listOf(home, tail))
        homeGone(c, blackHole = false)
        c.call("GET", "/api/phone/me")
        assertEquals(tail, c.host)
        where[home] = "127.0.0.1"
        c.networkChanged()
        seen.clear(); c.call("GET", "/api/phone/me")
        assertEquals(listOf(home), seen)
    }

    @Test fun theStreamOpensAtHomeWhenHomeAnswers() {
        val c = client(listOf(tail, home))
        val latch = java.util.concurrent.CountDownLatch(1)
        val ev = c.events("/api/events", { _, _ -> }, { up, _ -> if (up) latch.countDown() })
        latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        ev.close()
        assertEquals(home, seen.first())
    }
}
