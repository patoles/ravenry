package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The words when the Mac does not answer (Reach): Tailscale or the Mac, never a host. */
class ReachTest {
    private val away = listOf("192.168.1.20", "ravenry.tail1234.ts.net", "100.64.0.2")

    @Test fun knowsTheTailnetsHosts() {
        assertTrue(Reach.tailnetHost("ravenry.tailabcdef.ts.net"))
        assertTrue(Reach.tailnetHost("100.64.0.2"))
        assertTrue(Reach.tailnetHost("100.127.255.1"))
        assertTrue(Reach.tailnetHost("fd7a:115c:a1e0::1"))
        assertTrue(Reach.tailnetHost("[fd7a:115c:a1e0:ab12::5]"))
        assertFalse(Reach.tailnetHost("100.128.0.1"))
        assertFalse(Reach.tailnetHost("192.168.1.20"))
        assertFalse(Reach.tailnetHost("10.0.2.2"))
        assertFalse(Reach.tailnetHost("studio.local"))
    }

    @Test fun tailscaleOffOrMissingWhenOnlyTheTailnetCouldAnswer() {
        assertEquals(Reach.TAILSCALE_OFF, Reach.decide(away, vpnUp = false, tailscaleInstalled = true))
        assertEquals(Reach.TAILSCALE_MISSING, Reach.decide(away, vpnUp = false, tailscaleInstalled = false))
        // Another VPN is up, but the tailnet's name did not resolve: Tailscale is still off.
        assertEquals(Reach.TAILSCALE_OFF, Reach.decide(away, vpnUp = true, tailscaleInstalled = true, tailnetNameUnresolved = true))
    }

    @Test fun theMacWhenTailscaleIsUpOrNotInTheLink() {
        assertEquals(Reach.MAC_AWAY, Reach.decide(away, vpnUp = true, tailscaleInstalled = true))
        assertEquals(Reach.MAC_HOME, Reach.decide(listOf("192.168.1.20"), vpnUp = false, tailscaleInstalled = false))
    }

    @Test fun neverAHostInTheWords() {
        for (w in listOf(Reach.TAILSCALE_OFF, Reach.TAILSCALE_MISSING, Reach.MAC_AWAY, Reach.MAC_HOME)) {
            assertFalse(w.words, Regex("""\d+\.\d+|ts\.net|:\d""").containsMatchIn(w.words))
        }
        assertEquals("Tailscale is off on this phone. Turn it on, then try again.", Reach.TAILSCALE_OFF.words)
    }

    @Test fun skipsTailnetHostsWithNoVpn() {
        val c = HubClient(away, 4601, null, null, skip = { Reach.tailnetHost(it) })
        assertEquals(listOf("192.168.1.20"), c.order())
        val none = HubClient(listOf("ravenry.tail1234.ts.net"), 4601, null, null, skip = { Reach.tailnetHost(it) })
        assertEquals(emptyList<String>(), none.order())
    }
}
