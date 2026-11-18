package dev.ravenry.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.SystemClock
import android.util.Log
import java.net.Inet4Address
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The paired Mac on the Wi-Fi (docs/PHONE.md, Finding the Mac on the
 * Wi-Fi): while phone access is on, the hub says `_ravenry._tcp` by Bonjour
 * with its id in the TXT record (hub/server/nearby.mjs). When no saved
 * Wi-Fi address answers (the Mac got a new address), HubClient asks here
 * before Tailscale: only a service whose id is the paired Mac's
 * ([Pins.hubId]) is taken, only its IPv4 Wi-Fi addresses (the hub's phone
 * port takes no other), and the pinned key still decides whether it is
 * that Mac. Off the Wi-Fi (mobile data only) nothing is looked for.
 */
object Nearby {
    const val SERVICE = "_ravenry._tcp"
    /** How long a look lasts at most; the Mac on the same Wi-Fi answers in well under a second. */
    const val LOOK_MS = 3000L

    /** A service the look found: the id in its TXT record (null: none), and its addresses. */
    data class Service(val id: String?, val addresses: List<String>)

    /** The addresses of the services with this id: IPv4, not a tailnet one, each once. */
    fun matching(found: List<Service>, id: String): List<String> =
        found.filter { it.id == id }.flatMap { it.addresses }.filter { ipv4(it) && !Reach.tailnetHost(it) }.distinct()

    private fun ipv4(a: String): Boolean { val q = a.split('.'); return q.size == 4 && q.all { it.toIntOrNull() in 0..255 } }

    /** The finder HubClient uses for the Mac with this pin. */
    fun finder(context: Context, pin: String): () -> List<String> {
        val app = context.applicationContext
        val id = Pins.hubId(pin)
        return { if (onLan(app)) look(app, id, LOOK_MS) else emptyList() }
    }

    /** The phone is on a Wi-Fi (or a wired network): a Bonjour look can find something. */
    @Suppress("DEPRECATION")
    fun onLan(context: Context): Boolean = runCatching {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm.allNetworks.any { n -> cm.getNetworkCapabilities(n)?.let { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || it.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) } == true }
    }.getOrDefault(true)

    /**
     * Looks for `_ravenry._tcp` for at most [ms] and resolves what it finds,
     * one at a time (Android resolves one service at a time), until a
     * service with this id has an address. Its addresses, or none.
     */
    @Suppress("DEPRECATION")
    fun look(context: Context, id: String, ms: Long): List<String> {
        val nsd = context.getSystemService(NsdManager::class.java) ?: return emptyList()
        val t0 = SystemClock.elapsedRealtime()
        val seen = LinkedBlockingQueue<NsdServiceInfo>()
        val found = ArrayList<Service>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) { seen.add(info) }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { Log.w(TAG, "nearby: the look did not start ($code)") }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
        }
        try {
            nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            Log.w(TAG, "nearby: ${e.message}"); return emptyList()
        }
        try {
            while (true) {
                val left = ms - (SystemClock.elapsedRealtime() - t0)
                if (left <= 0) break
                val info = seen.poll(left, TimeUnit.MILLISECONDS) ?: break
                val r = resolve(nsd, info, ms - (SystemClock.elapsedRealtime() - t0)) ?: continue
                found.add(r)
                if (matching(listOf(r), id).isNotEmpty()) break
            }
        } finally {
            runCatching { nsd.stopServiceDiscovery(listener) }
        }
        val out = matching(found, id)
        val took = SystemClock.elapsedRealtime() - t0
        if (out.isNotEmpty()) Log.i(TAG, "nearby: found the paired Mac on the Wi-Fi at ${out.joinToString()} in $took ms")
        else Log.i(TAG, "nearby: the paired Mac is not on this Wi-Fi (${found.size} other Ravenry Mac(s) seen, $took ms)")
        return out
    }

    @Suppress("DEPRECATION")
    private fun resolve(nsd: NsdManager, info: NsdServiceInfo, ms: Long): Service? {
        if (ms <= 0) return null
        val done = CountDownLatch(1)
        var out: Service? = null
        val l = object : NsdManager.ResolveListener {
            override fun onResolveFailed(i: NsdServiceInfo, code: Int) { done.countDown() }
            override fun onServiceResolved(i: NsdServiceInfo) {
                val id = i.attributes["id"]?.let { String(it, Charsets.UTF_8) }
                val addrs = if (android.os.Build.VERSION.SDK_INT >= 34) i.hostAddresses else listOfNotNull(i.host)
                out = Service(id, addrs.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress })
                done.countDown()
            }
        }
        try { nsd.resolveService(info, l) } catch (e: Exception) { return null }
        done.await(ms, TimeUnit.MILLISECONDS)
        return out
    }

    private const val TAG = "Ravenry"
}
