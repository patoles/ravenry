package dev.ravenry.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.Closeable

/**
 * The connection held in the background while paired (docs/PHONE.md
 * section 4): the hub's live stream, so an alert shows at once even without
 * a push distributor, and the silent `connection` notification that says
 * what is linked and how many sessions work or need you.
 */
class ConnectionService : Service() {
    private var stream: Closeable? = null
    private var line: String = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val p = Store.get(this).paired()
        if (p == null) { stopSelf(); return START_NOT_STICKY }
        line = getString(R.string.linking, p.hubName)
        val n = Notifier.connection(this, line)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try { ServiceCompat.startForeground(this, Notifier.CONNECTION_ID, n, type) } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
        if (stream == null) {
            val hub = Hub.get(this) ?: run { stopSelf(); return START_NOT_STICKY }
            stream = hub.events("/api/events", { name, data ->
                when (name) {
                    "state" -> status(p.hubName, data)?.let { if (it != line) { line = it; Notifier.updateConnection(this, it) } }
                    "phone" -> Notifier.handle(this, data, fromPush = false)
                }
            }, { up, _ ->
                if (!up) { val t = getString(R.string.not_linked, p.hubName); if (t != line) { line = t; Notifier.updateConnection(this, t) } }
            })
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stream?.close(); stream = null
        super.onDestroy()
    }

    companion object {
        private val GROUP = mapOf("dialog" to "you", "asked" to "you", "draft" to "you", "handback" to "you", "working" to "work")

        /** "Linked to <computer> and <machines>. N sessions working, M need you." from a state snapshot. */
        fun status(hubName: String, json: String): String? {
            val o = runCatching { JSONObject(json) }.getOrNull() ?: return null
            val projects = o.optJSONArray("projects") ?: return null
            var work = 0; var you = 0
            val machines = linkedSetOf<String>()
            for (i in 0 until projects.length()) {
                val p = projects.optJSONObject(i) ?: continue
                p.optString("machine").takeIf { it.isNotEmpty() && it != "null" }?.let { machines += it }
                val ss = p.optJSONArray("sessions") ?: continue
                for (j in 0 until ss.length()) {
                    val s = ss.optJSONObject(j) ?: continue
                    s.optString("machine").takeIf { it.isNotEmpty() && it != "null" }?.let { machines += it }
                    val g = GROUP[s.optString("state")] ?: s.optJSONObject("words")?.optString("state")
                    if (g == "work") work++ else if (g == "you") you++
                }
            }
            val who = if (machines.isEmpty()) hubName else "$hubName and ${machines.joinToString(", ")}"
            val w = if (work == 1) "1 session working" else "$work sessions working"
            val y = "$you need you"
            return "Linked to $who. $w, $y."
        }

        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
