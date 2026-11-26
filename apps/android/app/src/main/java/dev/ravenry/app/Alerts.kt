package dev.ravenry.app

import org.json.JSONObject

/** One button of an alert (docs/PHONE.md section 5). */
/** `text`: a quick answer with no menu number is typed into the session as these words. `biometric`: a fingerprint first. */
data class AlertAction(val id: String, val label: String, val text: String? = null, val biometric: Boolean = false)

/** A part of what a drive would type, as the hub's one formatter split it (hub/public/keys.mjs): text, or a key as people read it ("Ctrl C"). */
data class KeyPart(val key: Boolean, val text: String)

/** One picture of a pick (docs/PHONE.md section 5): its label and where the hub serves it. */
data class AlertVariant(val label: String, val type: String, val url: String)

/** The reply line: `action` is "text" (an ask's own words) or "send" (typed into the session). */
data class AlertReply(val action: String, val label: String, val hint: String?)

/** A push message from the hub, as the shade draws it. */
data class Alert(
    val type: String,
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val detail: String?,
    val projectId: String?,
    val projectName: String?,
    val machine: String?,
    val surfaceId: String?,
    val checkpointId: String?,
    val actions: List<AlertAction>,
    val reply: AlertReply?,
    val raw: String,
    /** A pick's pictures, in order. */
    val variants: List<AlertVariant> = emptyList(),
    /** What a drive would type, in parts, so its keys are drawn as keys. */
    val keys: List<KeyPart> = emptyList(),
) {
    companion object {
        const val VERSION = 1
        private val KNOWN = setOf("ask", "approve", "secret", "permission", "question", "handback", "gate", "drive", "pick")

        private fun keysOf(a: org.json.JSONArray?): List<KeyPart> = (0 until (a?.length() ?: 0)).mapNotNull { i ->
            val p = a!!.optJSONObject(i) ?: return@mapNotNull null
            val t = p.str("text") ?: return@mapNotNull null
            KeyPart(p.str("kind") == "key", t)
        }

        /** The message, or null when it is not one this app reads (another version, another type). */
        fun parse(text: String): Alert? {
            val o = runCatching { JSONObject(text) }.getOrNull() ?: return null
            if (o.optInt("v", 0) != VERSION) return null
            val type = o.str("type") ?: return null
            val id = o.str("id") ?: return null
            if (type == "close") return Alert(type, id, "", "", "", null, null, null, null, null, null, emptyList(), null, text)
            if (type != "alert" && type != "test") return null
            val kind = o.str("kind", type)
            val project = o.optJSONObject("project")
            val session = o.optJSONObject("session")
            val cp = o.optJSONObject("checkpoint")
            val list = o.optJSONArray("actions")
            var actions = (0 until (list?.length() ?: 0)).mapNotNull { i ->
                val a = list!!.optJSONObject(i) ?: return@mapNotNull null
                val aid = a.str("id"); val label = a.str("label")
                if (aid == null || label == null) null else AlertAction(aid, label, a.str("text"), a.optBoolean("biometric", false))
            }
            val vlist = cp?.optJSONArray("variants")
            val variants = (0 until (vlist?.length() ?: 0)).mapNotNull { i ->
                val v = vlist!!.optJSONObject(i) ?: return@mapNotNull null
                val url = v.str("url") ?: return@mapNotNull null
                if (!url.startsWith("/api/")) null else AlertVariant(v.str("label", ""), v.str("type", "image"), url)
            }
            // A pick in the shade shows its pictures side by side, small:
            // Compare opens the swipe screen, where a part can be circled and
            // a note added; Not now leaves it for later (the agent keeps
            // waiting, the computer keeps showing it).
            if (kind == "pick") actions = listOf(AlertAction("open", "Compare"), AlertAction("later", "Not now"))
            // Allowing an agent to type into a pane is as strong as running a
            // command there: a fingerprint first, whatever the message says.
            var title = o.str("title", "")
            var body = o.str("body", "")
            var detail = o.str("detail")
            if (kind == "drive") {
                val dj = cp?.optJSONObject("drive")
                fun f(k: String) = dj.str(k)
                val d = Drive.of(f("action"), title, body, f("name"), project.str("name") ?: f("session"), f("reason"), session.str("assistant"), session.str("assistantName"))
                title = d.title; body = d.body
                if (d.says != null) detail = d.says
                actions = actions.mapNotNull { act ->
                    when {
                        act.id == "allow:once" -> act.copy(label = d.yes, biometric = true)
                        act.id == "allow:session" -> if (d.session) act.copy(biometric = true) else null
                        else -> act
                    }
                }
            }
            // A kind this app does not know shows its title and body with Open only.
            if (kind !in KNOWN && type != "test") actions = listOf(AlertAction("open", "Open"))
            val r = o.optJSONObject("reply")
            // A secret is never typed into a notification, whatever the message says.
            val reply = if (r == null || kind == "secret" || kind !in KNOWN) null
                else AlertReply(r.str("action", "send"), r.str("label", "Reply"), r.str("hint"))
            // Android shows at most three buttons, the reply line counting as one.
            val room = if (reply != null) 2 else 3
            if (actions.size > room) {
                val open = actions.firstOrNull { it.id == "open" } ?: AlertAction("open", "Open")
                actions = actions.filter { it.id != "open" }.take(room - 1) + open
            }
            return Alert(
                type, id, kind, title, body, detail,
                project.str("id"), project.str("name"),
                o.str("machine"),
                session.str("surfaceId"),
                cp.str("id"),
                actions, reply, text, variants,
                keysOf(cp?.optJSONObject("drive")?.optJSONArray("keys")),
            )
        }
    }
}

/**
 * A drive in the shade says who wants to do what (`checkpoint.drive.action`:
 * input, close, restart, override) to which pane, by the names the board
 * shows, never a pane id, and the asker by its project, never its
 * session's name: "paper-boat wants to close dev server",
 * with Let it close and Refuse; typing keeps Allow once and This session.
 * A hub that sends `checkpoint.drive.name` writes the title, body and
 * detail that way itself (docs/PHONE.md section 5); for an older one the
 * names come from `.session` and the daemon's own title in the body, and
 * the agent's words (`drive.reason`) follow as "Claude says: ...".
 */
data class Drive(val title: String, val body: String, val yes: String, val session: Boolean, val says: String? = null) {
    companion object {
        private val NAMED = Regex("\"([^\"]+)\" \\(pane [a-z0-9]+\\)")

        fun of(action: String?, title: String, body: String, name: String? = null, asking: String? = null, reason: String? = null, assistant: String? = null, assistantName: String? = null): Drive {
            val yes = when (action) { "close" -> "Let it close"; "restart" -> "Let it restart"; "override" -> "Let it change it"; else -> "Allow once" }
            // A hub that names the pane already says it all: "Claude, in
            // Tilting the hull, wants to type in dev server", the agent's
            // words in the body and what it would type in the detail.
            if (name != null) return Drive(title, body, yes, action == null || action == "input")
            // The assistant's word is the hub's (its registry, sent as the
            // session's assistantName); an older hub sends only the id.
            val who = assistantName?.takeIf { it.isNotBlank() }
                ?: assistant?.let { when (it) { "claude" -> "Claude"; "codex" -> "Codex"; else -> null } }
                ?: title.substringBefore(" wants ", "").substringBefore(",").takeIf { it.isNotEmpty() && !it.startsWith("Let ") } ?: "The agent"
            // The pane's name from the daemon's title, in the body or the title, without its id.
            val pane = (NAMED.find(body) ?: NAMED.find(title))?.groupValues?.get(1)
            val rest = if (NAMED.containsMatchIn(body) || body.matches(Regex("^Let .+\\?$"))) "" else body
            val subject = asking ?: who
            // A hub that put the agent's words in the body already said them.
            val says = reason?.trim()?.takeIf { it.isNotEmpty() && !rest.contains(" says: ") }?.let { "$who says: $it" }
            val p = pane ?: "another tab"
            return when (action) {
                "close" -> Drive("$subject wants to close $p", rest, "Let it close", false, says)
                "restart" -> Drive("$subject wants to restart $p", rest, "Let it restart", false, says)
                "override" -> Drive("$subject wants to change how $p runs", rest, "Let it change it", false, says)
                else -> Drive(if (pane != null || asking != null) "$subject wants to type in $p" else title, rest, "Allow once", true, says)
            }
        }
    }
}

/** What an action calls on the hub, as the device (docs/PHONE.md section 5). */
sealed class ActionCall {
    data class Post(val path: String, val json: String) : ActionCall()
    /** Fingerprint first, then this post. */
    data class Run(val post: Post) : ActionCall()
    object Open : ActionCall()
    /** Not now: the alert goes from the shade, nothing is sent. */
    object Later : ActionCall()
}

object Actions {
    private fun q(s: String) = JSONObject.quote(s)

    private fun answer(cp: String, field: String) = ActionCall.Post("/api/checkpoints/answer", "{\"id\":${q(cp)},$field,\"by\":\"phone\"}")

    /** The call for a button, or for the reply line (`id` "reply" with its text). Null when it cannot be made. */
    fun call(a: Alert, id: String, text: String? = null): ActionCall? {
        val cp = a.checkpointId
        return when {
            id == "open" -> ActionCall.Open
            id == "reply" -> {
                val t = text?.trim().orEmpty()
                if (t.isEmpty() || a.kind == "secret") null
                else if (a.reply?.action == "text" && cp != null) answer(cp, "\"text\":${q(t)}")
                else if (a.projectId != null && a.surfaceId != null) ActionCall.Post("/api/send", "{\"projectId\":${q(a.projectId)},\"surfaceId\":${q(a.surfaceId)},\"text\":${q(t)}}")
                else null
            }
            id.startsWith("choice:") -> { val i = id.substring(7).toIntOrNull(); if (cp == null || i == null) null else answer(cp, "\"choice\":$i") }
            id == "run" -> if (cp == null) null else ActionCall.Run(answer(cp, "\"approve\":true"))
            id == "allow:once" || id == "allow:session" -> if (cp == null || a.kind != "drive") null else ActionCall.Run(answer(cp, "\"approve\":true,\"allow\":${q(id.substring(6))}"))
            id.startsWith("pick:") -> {
                val i = id.substring(5).toIntOrNull()
                val v = if (i == null) null else a.variants.getOrNull(i)
                if (cp == null || v == null || v.label.isEmpty()) null else answer(cp, "\"pick\":{\"label\":${q(v.label)}}")
            }
            id == "later" -> ActionCall.Later
            id == "refuse" || id == "decline" -> if (cp == null) null else answer(cp, "\"decline\":true")
            id.startsWith("quick:") -> {
                val n = id.substring(6).toIntOrNull()
                val words = a.actions.firstOrNull { it.id == id }?.text
                if (n == null || a.projectId == null || a.surfaceId == null) null
                else if (words != null) ActionCall.Post("/api/send", "{\"projectId\":${q(a.projectId)},\"surfaceId\":${q(a.surfaceId)},\"text\":${q(words)}}")
                else ActionCall.Post("/api/send", "{\"projectId\":${q(a.projectId)},\"surfaceId\":${q(a.surfaceId)},\"choice\":$n}")
            }
            else -> null
        }
    }
}

/**
 * What still waits for the person in a state snapshot (the board's
 * `projects` and open `checkpoints`), to tell whether an alert in the shade
 * is still worth showing (Notifier.sweep).
 */
class Waiting private constructor(private val open: Set<String>, private val projects: Map<String, org.json.JSONObject>) {
    /** Whether the alert's question still waits. Alerts of other kinds (a test) say yes: they end on their own. */
    fun still(a: Alert): Boolean = when {
        a.id.startsWith("cp:") -> a.checkpointId != null && a.checkpointId in open
        a.id.startsWith("s:") -> projects[a.projectId]?.let { p -> p.str("state") == "you" && p.str("primary") == a.surfaceId } ?: false
        a.id.startsWith("gate:") -> projects[a.projectId]?.let { p -> p.str("state") == "you" && p.optJSONObject("planGate") != null } ?: false
        else -> true
    }

    companion object {
        /** Null when the snapshot has no projects (not a whole one). */
        fun of(o: org.json.JSONObject): Waiting? {
            val ps = o.optJSONArray("projects") ?: return null
            val open = hashSetOf<String>()
            o.optJSONArray("checkpoints")?.let { cps -> for (i in 0 until cps.length()) { val c = cps.optJSONObject(i) ?: continue; if (c.str("state") == "open") c.str("id")?.let { open += it } } }
            val byId = HashMap<String, org.json.JSONObject>()
            for (i in 0 until ps.length()) { val p = ps.optJSONObject(i) ?: continue; p.str("id")?.let { byId[it] = p } }
            return Waiting(open, byId)
        }
    }
}
