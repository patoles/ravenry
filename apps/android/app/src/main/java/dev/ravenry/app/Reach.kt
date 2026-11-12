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

    /** A VPN is up on this phone (Tailscale is one when it is on). */
    fun vpnUp(context: Context): Boolean = runCatching {
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
