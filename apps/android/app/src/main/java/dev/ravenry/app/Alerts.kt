package dev.ravenry.app

import org.json.JSONObject

/** One button of an alert (docs/PHONE.md section 5). */
/** `text`: a quick answer with no menu number is typed into the session as these words. */
data class AlertAction(val id: String, val label: String, val text: String? = null)

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
) {
    companion object {
        const val VERSION = 1
        private val KNOWN = setOf("ask", "approve", "secret", "permission", "question", "handback", "gate")

        /** The message, or null when it is not one this app reads (another version, another type). */
        fun parse(text: String): Alert? {
            val o = runCatching { JSONObject(text) }.getOrNull() ?: return null
            if (o.optInt("v", 0) != VERSION) return null
            val type = o.optString("type")
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: return null
            if (type == "close") return Alert(type, id, "", "", "", null, null, null, null, null, null, emptyList(), null, text)
            if (type != "alert" && type != "test") return null
            val kind = o.optString("kind", type)
            val project = o.optJSONObject("project")
            val session = o.optJSONObject("session")
            val cp = o.optJSONObject("checkpoint")
            val list = o.optJSONArray("actions")
            var actions = (0 until (list?.length() ?: 0)).mapNotNull { i ->
                val a = list!!.optJSONObject(i) ?: return@mapNotNull null
                val aid = a.optString("id"); val label = a.optString("label")
                if (aid.isEmpty() || label.isEmpty()) null else AlertAction(aid, label, a.optString("text").takeIf { it.isNotEmpty() })
            }
            // A kind this app does not know shows its title and body with Open only.
            if (kind !in KNOWN && type != "test") actions = listOf(AlertAction("open", "Open"))
            val r = o.optJSONObject("reply")
            // A secret is never typed into a notification, whatever the message says.
            val reply = if (r == null || kind == "secret" || kind !in KNOWN) null
                else AlertReply(r.optString("action", "send"), r.optString("label", "Reply"), r.optString("hint").takeIf { it.isNotEmpty() })
            // Android shows at most three buttons, the reply line counting as one.
            val room = if (reply != null) 2 else 3
            if (actions.size > room) {
                val open = actions.firstOrNull { it.id == "open" } ?: AlertAction("open", "Open")
                actions = actions.filter { it.id != "open" }.take(room - 1) + open
            }
            return Alert(
                type, id, kind, o.optString("title"), o.optString("body"), o.optString("detail").takeIf { it.isNotEmpty() },
                project?.optString("id")?.takeIf { it.isNotEmpty() }, project?.optString("name")?.takeIf { it.isNotEmpty() },
                o.optString("machine").takeIf { it.isNotEmpty() && it != "null" },
                session?.optString("surfaceId")?.takeIf { it.isNotEmpty() },
                cp?.optString("id")?.takeIf { it.isNotEmpty() },
                actions, reply, text,
            )
        }
    }
}

/** What an action calls on the hub, as the device (docs/PHONE.md section 5). */
sealed class ActionCall {
    data class Post(val path: String, val json: String) : ActionCall()
    /** Fingerprint first, then this post. */
    data class Run(val post: Post) : ActionCall()
    object Open : ActionCall()
}

object Actions {
    private fun q(s: String) = JSONObject.quote(s)

    private fun answer(cp: String, field: String) = ActionCall.Post("/api/checkpoints/answer", "{\"checkpoint\":${q(cp)},$field,\"by\":\"phone\"}")

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
