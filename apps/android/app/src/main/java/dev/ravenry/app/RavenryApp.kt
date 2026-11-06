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
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { if (Store.get(this@RavenryApp).paired() != null) ConnectionService.start(this@RavenryApp) }
        })
    }
}

/** The client for the paired computer, shared by the page, the shade and the services. */
object Hub {
    val io = Executors.newCachedThreadPool()
    @Volatile private var client: HubClient? = null
    @Volatile private var forToken: String? = null

    fun get(context: Context): HubClient? {
        val store = Store.get(context)
        val p = store.paired() ?: return null
        client?.let { if (forToken == p.token) return it }
        val app = context.applicationContext
        return HubClient.of(p, onHost = { store.rememberHost(it) }, onSignedOut = { signedOut(app) }).also { client = it; forToken = p.token }
    }

    /** The hub forgot this device (revoked, unpaired, a new key): back to pairing. */
    fun signedOut(context: Context) {
        Store.get(context).clear()
        client = null; forToken = null
        ConnectionService.stop(context)
        context.startActivity(Intent(context, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra(PairActivity.SIGNED_OUT, true))
    }

    fun reset() { client = null; forToken = null }
}
