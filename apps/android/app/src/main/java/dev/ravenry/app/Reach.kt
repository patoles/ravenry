package dev.ravenry.app

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri

/**
 * Why the Mac cannot be reached, in plain words (docs/PHONE.md, Reaching
 * the Mac): never a host name or an address. Away from home the phone
 * reaches the Mac through Tailscale; with Tailscale off on the phone the
 * tailnet's names do not resolve and its addresses do not answer, so the
 * phone says so and offers to open Tailscale, or to get it.
 */
object Reach {
    const val TAILSCALE = "com.tailscale.ipn"

    data class Why(val reason: String, val words: String)

    val TAILSCALE_OFF = Why("tailscale-off", "Tailscale is off on this phone. Turn it on, then try again.")
    val TAILSCALE_MISSING = Why("tailscale-missing", "This phone doesn't have Tailscale. Install it and sign in, then try again.")
    val MAC_AWAY = Why("unreachable", "Your Mac didn't answer. Check that it's on and awake, and that Tailscale is connected on both.")
    val MAC_HOME = Why("unreachable", "Your Mac didn't answer. Check that it's on and awake, and that this phone is on its Wi-Fi.")

    /** A host only the tailnet reaches: a MagicDNS name, a 100.64/10 or fd7a:115c:a1e0:: address. */
    fun tailnetHost(h: String): Boolean {
        val s = h.trim().lowercase().removePrefix("[").removeSuffix("]")
        if (s.endsWith(".ts.net")) return true
        if (s.startsWith("fd7a:115c:a1e0:")) return true
        val q = s.split('.')
        if (q.size == 4 && q.all { it.toIntOrNull() in 0..255 }) return q[0] == "100" && q[1].toInt() in 64..127
        return false
    }

    /**
     * The words for a failure to reach the Mac at these hosts: Tailscale
     * when only the tailnet could have answered and no VPN is up (or a
     * tailnet name did not resolve), else that the Mac did not answer.
     */
    fun decide(hosts: List<String>, vpnUp: Boolean, tailscaleInstalled: Boolean, tailnetNameUnresolved: Boolean = false): Why {
        val tail = hosts.any(::tailnetHost)
        if (tail && (!vpnUp || tailnetNameUnresolved)) return if (tailscaleInstalled) TAILSCALE_OFF else TAILSCALE_MISSING
        return if (tail) MAC_AWAY else MAC_HOME
    }

    /**
     * The path a host is: "tailscale" (Ravenry's own device on the person's
     * tailnet: its MagicDNS name ravenry.<tailnet>.ts.net, or the 100.x
     * address the pairing link lists right after it), "tailscale-mac" (the
     * Mac's own Tailscale app's addresses), "local" (this device itself) or
     * "wifi" (an address on the home network).
     */
    fun via(host: String, hosts: List<String>): String {
        val h = host.trim().lowercase()
        if (h == "127.0.0.1" || h == "localhost" || h == "::1") return "local"
        if (!tailnetHost(h)) return "wifi"
        val own = { x: String? -> x != null && x.lowercase().startsWith("ravenry.") && x.lowercase().endsWith(".ts.net") }
        if (own(h)) return "tailscale"
        val i = hosts.indexOfFirst { it.equals(host, true) }
        return if (i > 0 && own(hosts[i - 1])) "tailscale" else "tailscale-mac"
    }

    /** A VPN is up on this phone (Tailscale is one when it is on). */
    fun vpnUp(context: Context): Boolean = DebugNet.vpn(context) || runCatching {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }.getOrDefault(true)

    fun tailscaleInstalled(context: Context): Boolean =
        runCatching { context.packageManager.getPackageInfo(TAILSCALE, 0); true }.getOrDefault(false)

    /** This phone's words for a failure to reach the Mac at these hosts. */
    fun why(context: Context, hosts: List<String>, e: Throwable?): Why {
        val unresolved = generateSequence(e) { it.cause }.any { it is java.net.UnknownHostException && hosts.any { h -> tailnetHost(h) && it.message?.contains(h) == true } }
        return decide(hosts, vpnUp(context), tailscaleInstalled(context), unresolved)
    }

    /** Skip a host now: a tailnet one with no VPN up cannot answer, and waiting on it only delays the words. */
    fun skip(context: Context): (String) -> Boolean = { h -> tailnetHost(h) && !vpnUp(context) }

    /** Opens the Tailscale app, or its page in the phone's store when it is not installed. */
    fun openTailscale(context: Context) {
        val launch = context.packageManager.getLaunchIntentForPackage(TAILSCALE)
        val i = launch ?: Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$TAILSCALE"))
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(i) }.onFailure {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://tailscale.com/download/android")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }
}

/**
 * A debug build's stand-in network for the end-to-end test (apps/phone/tools/
 * phone-e2e.mjs): `files/debug-net.json`, pushed with `adb shell run-as`,
 * says `{"dns": {"ravenry.tail0000.ts.net": "10.0.2.2"}, "vpn": true}`, so a
 * stand-in tailnet name answers and a VPN counts as up. A release build never
 * reads it.
 */
object DebugNet {
    private fun read(context: Context): org.json.JSONObject? {
        if (!BuildConfig.DEBUG) return null
        val f = java.io.File(context.filesDir, "debug-net.json")
        return if (f.exists()) runCatching { org.json.JSONObject(f.readText()) }.getOrNull() else null
    }

    fun vpn(context: Context): Boolean = read(context)?.optBoolean("vpn", false) == true

    fun dns(context: Context): okhttp3.Dns? {
        if (!BuildConfig.DEBUG) return null
        val app = context.applicationContext
        return object : okhttp3.Dns {
            override fun lookup(hostname: String): List<java.net.InetAddress> {
                val ip = read(app)?.optJSONObject("dns")?.optString(hostname)?.takeIf { it.isNotEmpty() }
                return if (ip != null) listOf(java.net.InetAddress.getByName(ip)) else okhttp3.Dns.SYSTEM.lookup(hostname)
            }
        }
    }
}
