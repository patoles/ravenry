package dev.ravenry.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.concurrent.Executors

class RavenryApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(Notifier.NEEDS_YOU, getString(R.string.channel_needs_you), NotificationManager.IMPORTANCE_HIGH).apply {
            description = getString(R.string.channel_needs_you_about)
        })
        nm.createNotificationChannel(NotificationChannel(Notifier.CONNECTION, getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
            description = getString(R.string.channel_connection_about)
            setShowBadge(false)
            setSound(null, null)
        })
        // While paired, a foreground service holds the connection, so alerts
        // arrive without push too. Android lets a foreground service start
        // only while the app is in front, so it starts then and keeps running.
        // A sign-out the computer has not heard yet: told now, if it answers.
        Revokes.flush(this)
        Hub.watchNetwork(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { if (Store.get(this@RavenryApp).paired() != null && Store.get(this@RavenryApp).stayConnected) ConnectionService.start(this@RavenryApp) }
        })
    }
}

/** The client for the paired computer, shared by the page, the shade and the services. */
object Hub {
    val io = Executors.newCachedThreadPool()
    @Volatile private var client: HubClient? = null
    @Volatile private var forToken: String? = null

    // One client at a time: the board, the connection service and the shade
    // ask at once at a start, and two clients would each look for the Mac
    // on the Wi-Fi (Nearby) and keep their own idea of where it answers.
    @Synchronized fun get(context: Context): HubClient? {
        val store = Store.get(context)
        val p = store.paired() ?: return null
        client?.let { if (forToken == p.token) return it }
        val app = context.applicationContext
        // A host that answers is remembered, so the next start goes straight
        // there (one the Mac was found at on the Wi-Fi too: Nearby).
        val onHost = { h: String -> store.rememberHost(h); android.util.Log.i("Ravenry", "connection: the Mac answers at $h (${Reach.via(h, store.paired()?.hosts ?: emptyList())})"); Unit }
        return HubClient.of(p, onHost = onHost, onSignedOut = { signedOut(app) }, skip = Reach.skip(app), dns = DebugNet.dns(app), cache = boardCache(app), finder = Nearby.finder(app, p.pin)).also { client = it; forToken = p.token }
    }

    /** The board's files between reloads (HubClient `cache`): one per folder, as OkHttp wants. */
    @Volatile private var cache: okhttp3.Cache? = null
    @Synchronized private fun boardCache(app: Context): okhttp3.Cache =
        cache ?: okhttp3.Cache(java.io.File(app.cacheDir, "board-files"), 16L * 1024 * 1024).also { cache = it }

    /** The hub forgot this device (revoked, unpaired, a new key): back to pairing. */
    fun signedOut(context: Context) {
        Store.get(context).clear()
        client = null; forToken = null
        ConnectionService.stop(context)
        context.startActivity(Intent(context, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra(PairActivity.SIGNED_OUT, true))
    }

    fun reset() { client = null; forToken = null }

    /** Told when the phone joins or leaves a network (the connection watch checks at once). */
    @Volatile var onNetwork: (() -> Unit)? = null

    /**
     * Joining or leaving a Wi-Fi (or the mobile network): every home address
     * is worth a first try again, and the connection watch checks now rather
     * than at its next 30 s check (docs/PHONE.md, The connection).
     */
    fun watchNetwork(context: Context) {
        val cm = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return
        // A plain request leaves VPNs out: the networks under Tailscale, which change when the phone comes home.
        val req = android.net.NetworkRequest.Builder().addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) = changed()
            override fun onLost(network: android.net.Network) = changed()
        }
        runCatching { cm.registerNetworkCallback(req, cb) }
    }

    private fun changed() {
        client?.networkChanged()
        ConnectionService.poke()
        onNetwork?.invoke()
    }
}

/**
 * Sign out on this phone (docs/PHONE.md, Sign out): the screen changes on
 * the tap, and the computer is told (POST /api/phone/unpair with the old
 * token) in the background, at once and again later while it does not
 * answer: after 5 s, doubling to 5 min, and at every start of the app.
 * A 200 or a 401 (it forgot this phone already) ends it.
 */
object Revokes {
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    @Volatile private var wait = 5000L
    @Volatile private var running = false

    /** Signs this phone out here now, and tells the computer when it can. */
    fun signOut(context: Context) {
        val app = context.applicationContext
        val store = Store.get(app)
        store.paired()?.let { store.addRevoke(it) }
        store.clear(); Hub.reset(); ConnectionService.stop(app)
        Hub.io.execute { Push.unregister(app) }
        wait = 5000L
        flush(app)
    }

    fun flush(context: Context) {
        val app = context.applicationContext
        if (running) return
        running = true
        Hub.io.execute {
            val store = Store.get(app)
            for (p in store.revokes()) {
                val r = runCatching { HubClient.of(p, skip = Reach.skip(app), finder = Nearby.finder(app, p.pin)).call("POST", "/api/phone/unpair", "{}") }.getOrNull()
                if (r != null && (r.status == 200 || r.status == 401 || r.status == 404)) store.dropRevoke(p.token)
            }
            running = false
            if (store.revokes().isNotEmpty()) {
                main.postDelayed({ flush(app) }, wait)
                wait = (wait * 2).coerceAtMost(5 * 60 * 1000L)
            }
        }
    }
}
