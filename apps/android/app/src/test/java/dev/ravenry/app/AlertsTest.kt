package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsTest {
    private fun msg(kind: String, actions: String, reply: String? = null, extra: String = "") =
        """{"v":1,"type":"alert","id":"cp:c1234567","kind":"$kind","title":"T","body":"B","project":{"id":"notes-app","name":"notes-app"},"session":{"surfaceId":"ravenry:pabcdefg"},"checkpoint":{"id":"c1234567","kind":"$kind"},"actions":[$actions]${if (reply != null) ",\"reply\":$reply" else ""}$extra}"""

    private fun a(id: String, label: String) = """{"id":"$id","label":"$label"}"""

    @Test fun anAskWithItsOwnWordsHasTwoAnswersAndTheReplyLine() {
        val x = Alert.parse(msg("ask", listOf(a("choice:0", "Ship it"), a("choice:1", "Not yet")).joinToString(","), """{"action":"text","label":"Answer"}"""))!!
        assertEquals(listOf("choice:0", "choice:1"), x.actions.map { it.id })
        assertEquals("Answer", x.reply!!.label)
    }

    @Test fun threeButtonsAtMostWithOpenLast() {
        val four = (0..3).joinToString(",") { a("choice:$it", "O$it") }
        val x = Alert.parse(msg("ask", four))!!
        assertEquals(listOf("choice:0", "choice:1", "open"), x.actions.map { it.id })
        val y = Alert.parse(msg("ask", four, """{"action":"text","label":"Answer"}"""))!!
        assertEquals(listOf("choice:0", "open"), y.actions.map { it.id })
    }

    @Test fun aSecretNeverHasAReplyLine() {
        val x = Alert.parse(msg("secret", listOf(a("open", "Type it"), a("decline", "Not now")).joinToString(","), """{"action":"text","label":"Answer"}"""))!!
        assertNull(x.reply)
        assertEquals(listOf("open", "decline"), x.actions.map { it.id })
        assertNull(Actions.call(x, "reply", "hunter2-secret"))
    }

    @Test fun anUnknownKindShowsOpenOnly() {
        val x = Alert.parse(msg("future-thing", a("zap", "Zap"), """{"action":"send","label":"Reply"}"""))!!
        assertEquals(listOf("open"), x.actions.map { it.id })
        assertNull(x.reply)
    }

    @Test fun otherVersionsAndTypesAreIgnoredAndCloseIsRead() {
        assertNull(Alert.parse("""{"v":2,"type":"alert","id":"x"}"""))
        assertNull(Alert.parse("""{"v":1,"type":"party","id":"x"}"""))
        assertNull(Alert.parse("not json"))
        assertEquals("close", Alert.parse("""{"v":1,"type":"close","id":"cp:c1234567"}""")!!.type)
    }

    @Test fun eachActionMakesItsCall() {
        val ask = Alert.parse(msg("ask", a("choice:1", "Not yet"), """{"action":"text","label":"Answer"}"""))!!
        val c = Actions.call(ask, "choice:1") as ActionCall.Post
        assertEquals("/api/checkpoints/answer", c.path)
        assertEquals("""{"checkpoint":"c1234567","choice":1,"by":"phone"}""", c.json)
        assertEquals("""{"checkpoint":"c1234567","text":"Later today","by":"phone"}""", (Actions.call(ask, "reply", " Later today ") as ActionCall.Post).json)
        val run = Actions.call(Alert.parse(msg("approve", listOf(a("run", "Run"), a("refuse", "Refuse"), a("open", "Open")).joinToString(",")))!!, "run")
        assertTrue(run is ActionCall.Run)
        assertEquals("""{"checkpoint":"c1234567","approve":true,"by":"phone"}""", (run as ActionCall.Run).post.json)
        assertEquals("""{"checkpoint":"c1234567","decline":true,"by":"phone"}""", (Actions.call(ask, "refuse") as ActionCall.Post).json)
        val perm = Alert.parse(msg("permission", a("quick:2", "Yes, always")))!!
        val q = Actions.call(perm, "quick:2") as ActionCall.Post
        assertEquals("/api/send", q.path)
        assertEquals("""{"projectId":"notes-app","surfaceId":"ravenry:pabcdefg","choice":2}""", q.json)
        val words = Alert.parse(msg("question", """{"id":"quick:0","label":"10 minutes","text":"10 minutes"}""", """{"action":"send","label":"Reply"}"""))!!
        assertEquals("""{"projectId":"notes-app","surfaceId":"ravenry:pabcdefg","text":"10 minutes"}""", (Actions.call(words, "quick:0") as ActionCall.Post).json)
        val question = Alert.parse(msg("question", a("open", "Open"), """{"action":"send","label":"Reply"}"""))!!
        assertEquals("""{"projectId":"notes-app","surfaceId":"ravenry:pabcdefg","text":"30"}""", (Actions.call(question, "reply", "30") as ActionCall.Post).json)
        assertTrue(Actions.call(question, "open") is ActionCall.Open)
    }

    @Test fun theConnectionLineCountsSessions() {
        val s = """{"projects":[{"machine":null,"sessions":[{"state":"working"},{"state":"dialog"}]},{"machine":"devbox","sessions":[{"state":"idle","words":{"state":"work"}},{"state":"asked"},{"state":"idle"}]}]}"""
        assertEquals("Linked to Studio Mac and devbox. 2 sessions working, 2 need you.", ConnectionService.status("Studio Mac", s))
    }
}
