package dev.ravenry.app

import android.app.Activity
import android.content.Context
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Push through UnifiedPush (docs/PHONE.md section 4): any distributor (the
 * ntfy app, for one) gives an endpoint, the hub encrypts every alert for
 * this phone (RFC 8291) and the connector decrypts it here. No distributor:
 * the target is `none`, and alerts come only through the held connection.
 */
object Push {
    fun register(activity: Activity) {
        if (Store.get(activity).paired() == null) return
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
            if (ok) UnifiedPush.register(activity, messageForDistributor = "Ravenry")
            else target(activity.applicationContext, JSONObject().put("kind", "none"))
        }
    }

    fun unregister(context: Context) {
        runCatching { UnifiedPush.unregister(context) }
    }

    fun target(context: Context, body: JSONObject) {
        Hub.io.execute { runCatching { Hub.get(context)?.call("POST", "/api/phone/push", body.toString()) } }
    }
}

class RavenryPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        val body = if (keys == null) JSONObject().put("kind", "none")
            else JSONObject().put("kind", "unifiedpush").put("endpoint", endpoint.url).put("p256dh", keys.pubKey).put("auth", keys.auth)
        Push.target(applicationContext, body)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        // Only an encrypted message is the hub's: a plain one could come from
        // anyone who learned the endpoint.
        if (!message.decrypted) return
        Notifier.handle(applicationContext, String(message.content, Charsets.UTF_8), fromPush = true)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Push.target(applicationContext, JSONObject().put("kind", "none"))
    }

    override fun onUnregistered(instance: String) {
        Push.target(applicationContext, JSONObject().put("kind", "none"))
    }
}
