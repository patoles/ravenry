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

/**
 * The connection held in the background while paired (docs/PHONE.md
 * section 4): the hub's live stream, so an alert shows at once even without
 * a push distributor, and the silent `connection` notification that says
 * which Mac it reaches and how, and how many sessions work or need you.
 */
class ConnectionService : Service() {
    private var stream: HubClient.Stream? = null
    private var line: Line? = null
    private var counts: Counts? = null

    override fun onBind(intent: Intent?): IBinder? = null

    private fun show(l: Line) { if (l != line) { line = l; Notifier.updateConnection(this, l) } }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val p = Store.get(this).paired()
        if (p == null) { stopSelf(); return START_NOT_STICKY }
        val mac = MacName.say(p.hubName)
        val first = line ?: connecting(mac)
        line = first
        val n = Notifier.connection(this, first)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try { ServiceCompat.startForeground(this, Notifier.CONNECTION_ID, n, type) } catch (e: Exception) { android.util.Log.w("Ravenry", "connection service: ${e.message}"); stopSelf(); return START_NOT_STICKY }
        running = this
        if (stream == null) {
            val hub = Hub.get(this) ?: run { stopSelf(); return START_NOT_STICKY }
            val via = { Reach.via(hub.host, hub.allHosts) }
            stream = hub.events("/api/events", { name, data ->
                when (name) {
                    "state" -> {
                        counts(data)?.let { c -> counts = c; show(up(mac, via(), c)) }
                        // An alert whose question was answered or closed while
                        // the phone heard nothing (asleep, the hub restarted)
                        // goes now: the snapshot says what still waits.
                        Notifier.sweep(this, data)
                    }
                    "phone" -> Notifier.handle(this, data, fromPush = false)
                }
            }, { linked, err ->
                if (linked) show(up(mac, via(), counts))
                else {
                    android.util.Log.w("Ravenry", "connection: $err")
                    // Tailscale off or missing: said as such; else that it tries again.
                    val w = Reach.why(this, hub.allHosts, null)
                    show(down(mac, if (w.reason.startsWith("tailscale")) w.words else null))
                }
            })
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (running === this) running = null
        stream?.close(); stream = null
        super.onDestroy()
    }

    /** The connection notification: its title and its one short line. */
    data class Line(val title: String, val body: String?)

    /** What a state snapshot says: sessions working, needing you, and the other machines the Mac reaches. */
    data class Counts(val work: Int, val you: Int, val machines: List<String>)

    companion object {
        private val GROUP = mapOf("dialog" to "you", "asked" to "you", "draft" to "you", "handback" to "you", "working" to "work")

        /** The counts from a state snapshot, or null when it is not one. */
        fun counts(json: String): Counts? {
            val o = runCatching { JSONObject(json) }.getOrNull() ?: return null
            val projects = o.optJSONArray("projects") ?: return null
            var work = 0; var you = 0
            val machines = linkedSetOf<String>()
            // A session whose agent waits on an open checkpoint needs you,
            // whatever its own state says (the desktop's sidebar does the same).
            val waiting = hashSetOf<String>()
            o.optJSONArray("checkpoints")?.let { cps ->
                for (i in 0 until cps.length()) {
                    val c = cps.optJSONObject(i) ?: continue
                    val sid = c.str("surfaceId")
                    if (c.str("state") == "open" && sid != null) waiting += sid
                }
            }
            for (i in 0 until projects.length()) {
                val p = projects.optJSONObject(i) ?: continue
                p.str("machine")?.let { machines += MacName.say(it) }
                val ss = p.optJSONArray("sessions") ?: continue
                for (j in 0 until ss.length()) {
                    val s = ss.optJSONObject(j) ?: continue
                    s.str("machine")?.let { machines += MacName.say(it) }
                    val g = if (s.str("surfaceId") in waiting) "you" else GROUP[s.str("state")] ?: s.optJSONObject("words").str("state")
                    if (g == "work") work++ else if (g == "you") you++
                }
            }
            return Counts(work, you, machines.toList())
        }

        /** How the phone reaches the Mac, as the board's chip says it. */
        fun how(via: String): String = when (via) { "tailscale", "tailscale-mac" -> "Tailscale"; "local" -> "This computer"; else -> "Wi-Fi" }

        /** "2 working, 1 needs you.", or "Nothing running." */
        fun sessions(work: Int, you: Int): String {
            if (work == 0 && you == 0) return "Nothing running."
            val parts = listOfNotNull(if (work > 0) "$work working" else null, if (you > 0) (if (you == 1) "1 needs you" else "$you need you") else null)
            return parts.joinToString(", ") + "."
        }

        /** Linked: "Connected to MacBook Pro" over "Wi-Fi. 1 needs you." */
        fun up(mac: String, via: String, c: Counts?): Line {
            val others = c?.machines.orEmpty().filter { it != mac }
            val who = if (others.isEmpty()) mac else "$mac and ${others.joinToString(", ")}"
            return Line("Connected to $who", if (c == null) "${how(via)}." else "${how(via)}. ${sessions(c.work, c.you)}")
        }

        fun connecting(mac: String) = Line("Connecting to $mac", null)

        /** Not linked: why, when Tailscale is off or missing; else that it tries again. */
        fun down(mac: String, why: String?) = Line("Can't reach $mac", why ?: "Trying again.")

        @Volatile private var running: ConnectionService? = null

        /**
         * The phone's network changed, or the app heard the Mac while this
         * line still said it could not reach it: the stream tries again now
         * instead of at the end of its wait (up to 15 s), so the line says
         * Connected as soon as the Mac answers.
         */
        fun poke() { running?.stream?.wake() }

        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
