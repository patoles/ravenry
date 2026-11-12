package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PairingTest {
    private val pin = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

    @Test fun parsesTheLink() {
        val l = PairLink.parse("ravenry://pair?v=1&name=Studio%20Mac&hosts=192.168.1.20,100.101.102.103&port=4601&pin=$pin&code=ABCD-EFGH-JKMN-PQRS").getOrThrow()
        assertEquals("Studio Mac", l.name)
        assertEquals(listOf("192.168.1.20", "100.101.102.103"), l.hosts)
        assertEquals(4601, l.port)
        assertEquals(pin, l.pin)
        assertEquals("ABCDEFGHJKMNPQRS", l.code)
    }

    // Away from home (docs/PHONE.md section 2): the Wi-Fi first, then Ravenry's own
    // device on the person's tailnet by its MagicDNS name and its 100.x address.
    @Test fun takesTheTailnetNameAsAHost() {
        val l = PairLink.parse("ravenry://pair?v=1&name=Studio%20Mac&hosts=192.168.1.20,ravenry.tail1234.ts.net,100.64.0.2&port=4601&pin=$pin&code=ABCD-EFGH-JKMN-PQRS").getOrThrow()
        assertEquals(listOf("192.168.1.20", "ravenry.tail1234.ts.net", "100.64.0.2"), l.hosts)
        val c = HubClient(l.hosts, l.port, l.pin, null)
        assertEquals("https://ravenry.tail1234.ts.net:4601/api/phone/hello", c.url("ravenry.tail1234.ts.net", "/api/phone/hello"))
        assertEquals("https://100.64.0.2:4601/api/phone/hello", c.url("100.64.0.2", "/api/phone/hello"))
    }

    @Test fun refusesWhatIsNotALink() {
        fun err(s: String) = PairLink.parse(s).exceptionOrNull()?.message ?: ""
        assertTrue(err("https://example.com/pair").contains("not a Ravenry"))
        assertTrue(err("ravenry://pair?v=2&hosts=a&port=1&pin=$pin&code=ABCDEFGHJKMNPQRS").contains("Update Ravenry"))
        assertTrue(err("ravenry://pair?hosts=a&port=1&pin=$pin&code=ABCDEFGHJKMNPQRS").contains("no version"))
        assertTrue(err("ravenry://pair?v=1&port=1&pin=$pin&code=ABCDEFGHJKMNPQRS").contains("no address"))
        assertTrue(err("ravenry://pair?v=1&hosts=a&pin=$pin&code=ABCDEFGHJKMNPQRS").contains("no port"))
        assertTrue(err("ravenry://pair?v=1&hosts=a&port=1&code=ABCDEFGHJKMNPQRS").contains("no key"))
        assertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=short&code=ABCDEFGHJKMNPQRS").contains("key"))
        assertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=$pin").contains("no code"))
        assertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=$pin&code=ABC").contains("code"))
    }

    @Test fun readsATypedCodeKindly() {
        assertEquals("ABCDEFGH1JKM0PQR", PairLink.normalizeCode("abcd-efgh ijkm-opqr"))
        assertNull(PairLink.normalizeCode("ABCD-EFGH-JKMN-PQRU"))
        val t = PairLink.typed("192.168.1.20:4700", "ABCD-EFGH-JKMN-PQRS").getOrThrow()
        assertEquals(4700, t.port); assertEquals(listOf("192.168.1.20"), t.hosts); assertNull(t.pin)
        assertEquals(4601, PairLink.typed("mac.local", "ABCDEFGHJKMNPQRS").getOrThrow().port)
    }

    @Test fun theCheckNumberIsTheFirstFiveBytesModuloATrillion() {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val a = ByteArray(32).also { for (i in 0 until 5) it[i] = (i + 1).toByte() }
        // 0x0102030405 = 4328719365
        assertEquals("004328 719365", Pins.checkNumber(enc.encodeToString(a)))
        val b = ByteArray(32).also { for (i in 0 until 5) it[i] = 0xFF.toByte() }
        // 0xFFFFFFFFFF = 1099511627775, modulo 10^12
        assertEquals("099511 627775", Pins.checkNumber(enc.encodeToString(b)))
    }
}
