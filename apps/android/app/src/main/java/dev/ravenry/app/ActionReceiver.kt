package dev.ravenry.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONObject

/** A button or the reply line of an alert, answered from the shade without opening the app. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = Alert.parse(intent.getStringExtra(Notifier.EXTRA_ALERT) ?: return) ?: return
        val id = intent.getStringExtra(Notifier.EXTRA_ACTION) ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.REPLY_KEY)?.toString()
        val call = Actions.call(a, id, text) as? ActionCall.Post ?: return
        val label = if (id == "reply") text.orEmpty() else a.actions.firstOrNull { it.id == id }?.label ?: id
        val done = goAsync()
        Hub.io.execute {
            try { send(context, a, call, label) } finally { done.finish() }
        }
    }

    companion object {
        /** Makes the call as the device and says how it went in the notification. */
        fun send(context: Context, a: Alert, call: ActionCall.Post, label: String): Boolean {
            Notifier.answering(a.id)
            val hub = Hub.get(context)
            if (hub == null) { Notifier.after(context, a, false, context.getString(R.string.not_paired)); return false }
            val r = runCatching { hub.call("POST", call.path, call.json) }
            val ok = r.getOrNull()?.status == 200
            val said = when {
                ok -> context.getString(R.string.sent, label)
                r.isFailure -> context.getString(R.string.not_reached, Store.get(context).paired()?.hubName ?: "")
                else -> runCatching { JSONObject(r.getOrThrow().text).optString("error") }.getOrNull()?.takeIf { it.isNotEmpty() }
                    ?: context.getString(R.string.not_taken)
            }
            Notifier.after(context, a, ok, said)
            return ok
        }
    }
}
