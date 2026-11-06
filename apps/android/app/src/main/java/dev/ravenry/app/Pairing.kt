package dev.ravenry.app

import java.math.BigInteger
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * The pairing link the computer shows as a QR code (docs/PHONE.md section 3):
 * ravenry://pair?v=1&name=..&hosts=a,b&port=4601&pin=..&code=..
 */
data class PairLink(
    val name: String,
    val hosts: List<String>,
    val port: Int,
    val pin: String?,
    val code: String,
) {
    companion object {
        const val VERSION = 1

        /** The link's fields, or an error the pairing screen shows as it is. */
        fun parse(text: String): Result<PairLink> = runCatching {
            val s = text.trim()
            if (!s.startsWith("ravenry://pair")) error("This is not a Ravenry pairing code.")
            val uri = URI(s)
            val q = query(uri.rawQuery ?: "")
            val v = q["v"]?.toIntOrNull() ?: error("This pairing code has no version.")
            if (v > VERSION) error("This pairing code is newer than this app. Update Ravenry on the phone.")
            if (v < 1) error("This pairing code is not one Ravenry makes.")
            val hosts = (q["hosts"] ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
            if (hosts.isEmpty()) error("This pairing code has no address.")
            val port = q["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: error("This pairing code has no port.")
            val pin = q["pin"] ?: error("This pairing code has no key.")
            if (!PIN_RE.matches(pin)) error("This pairing code's key is not one Ravenry makes.")
            val code = normalizeCode(q["code"] ?: error("This pairing code has no code."))
                ?: error("This pairing code's code is not one Ravenry makes.")
            PairLink(q["name"]?.takeIf { it.isNotBlank() } ?: hosts.first(), hosts, port, pin, code)
        }

        private fun query(raw: String): Map<String, String> = raw.split('&').filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            val k = if (i < 0) it else it.substring(0, i)
            val v = if (i < 0) "" else it.substring(i + 1)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }

        val PIN_RE = Regex("^[A-Za-z0-9_-]{43}$")
        private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

        /** A pairing code as typed: dashes and spaces dropped, I and L read as 1, O as 0. 16 characters. */
        fun normalizeCode(raw: String): String? {
            val c = raw.uppercase().filter { it != '-' && !it.isWhitespace() }
                .map { when (it) { 'I', 'L' -> '1'; 'O' -> '0'; else -> it } }.joinToString("")
            return if (c.length == 16 && c.all { it in CROCKFORD }) c else null
        }

        /** "host" or "host:port" as the person typed the computer's address. */
        fun typed(address: String, code: String, defaultPort: Int = 4601): Result<PairLink> = runCatching {
            val a = address.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')
            if (a.isEmpty()) error("Type the computer's address.")
            val i = a.lastIndexOf(':')
            val (host, port) = if (i > 0 && !a.substring(0, i).contains(':')) a.substring(0, i) to a.substring(i + 1).toIntOrNull() else a to defaultPort
            if (port == null || port !in 1..65535) error("That port is not a number.")
            val c = normalizeCode(code) ?: error("The code has 16 letters and digits, like ABCD-EFGH-JKMN-PQRS.")
            PairLink(host, listOf(host), port, null, c)
        }
    }
}

object Pins {
    private val b64u = Base64.getUrlEncoder().withoutPadding()

    /** The pin of a certificate: base64url SHA-256 of its SubjectPublicKeyInfo. */
    fun of(cert: X509Certificate): String = b64u.encodeToString(sha256(cert.publicKey.encoded))

    fun bytes(pin: String): ByteArray = Base64.getUrlDecoder().decode(pin)

    /**
     * The check number of a typed pairing: the first five bytes of the pin read
     * as one big-endian number, modulo 10^12, as two groups of six digits.
     */
    fun checkNumber(pin: String): String {
        val n = BigInteger(1, bytes(pin).copyOfRange(0, 5)).mod(BigInteger.TEN.pow(12))
        val s = n.toString().padStart(12, '0')
        return s.substring(0, 6) + " " + s.substring(6)
    }

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
}
