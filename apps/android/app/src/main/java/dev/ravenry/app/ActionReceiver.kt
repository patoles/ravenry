package dev.ravenry.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import org.json.JSONObject

/** A button or the reply line of an alert, answered from the shade without opening the app. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Notifier.ACTION_SYNC) { Notifier.syncSummary(context); return }
        val a = Alert.parse(intent.getStringExtra(Notifier.EXTRA_ALERT) ?: return) ?: return
        val id = intent.getStringExtra(Notifier.EXTRA_ACTION) ?: return
        // The demo's alert: its card answered on the demo's screen, nothing sent (Demo.kt).
        if (a.id.startsWith(Demo.PREFIX)) { Demo.action(context, a, id); return }
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.REPLY_KEY)?.toString()
        val made = Actions.call(a, id, text)
        if (made is ActionCall.Later) { Notifier.cancel(context, a.id); return }
        val call = made as? ActionCall.Post ?: return
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
                ok && call.path == "/api/decisions/undo" -> if (a.decisionIds.size > 1) context.getString(R.string.undone_many, a.decisionIds.size) else context.getString(R.string.undone)
                ok -> context.getString(R.string.sent, label)
                r.isFailure -> context.getString(R.string.not_sent_why, Reach.why(context, hub.allHosts, r.exceptionOrNull()).words)
                else -> runCatching { JSONObject(r.getOrThrow().text).str("error") }.getOrNull()
                    ?: context.getString(R.string.not_taken)
            }
            Notifier.after(context, a, ok, said)
            return ok
        }
    }
}
