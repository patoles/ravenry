package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsTest {
    private fun msg(kind: String, actions: String, reply: String? = null, extra: String = "", cp: String = """{"id":"c1234567","kind":"$kind"}""") =
        """{"v":1,"type":"alert","id":"cp:c1234567","kind":"$kind","title":"T","body":"B","project":{"id":"notes-app","name":"notes-app"},"session":{"surfaceId":"ravenry:pabcdefg"},"checkpoint":$cp,"actions":[$actions]${if (reply != null) ",\"reply\":$reply" else ""}$extra}"""

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
        assertEquals("""{"id":"c1234567","choice":1,"by":"phone"}""", c.json)
        assertEquals("""{"id":"c1234567","text":"Later today","by":"phone"}""", (Actions.call(ask, "reply", " Later today ") as ActionCall.Post).json)
        val run = Actions.call(Alert.parse(msg("approve", listOf(a("run", "Run"), a("refuse", "Refuse"), a("open", "Open")).joinToString(",")))!!, "run")
        assertTrue(run is ActionCall.Run)
        assertEquals("""{"id":"c1234567","approve":true,"by":"phone"}""", (run as ActionCall.Run).post.json)
        assertEquals("""{"id":"c1234567","decline":true,"by":"phone"}""", (Actions.call(ask, "refuse") as ActionCall.Post).json)
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


    @Test fun aDriveAsksForAFingerprintBeforeEitherAllow() {
        val acts = listOf("""{"id":"allow:once","label":"Allow once","biometric":true}""", """{"id":"allow:session","label":"This session"}""", a("refuse", "Refuse")).joinToString(",")
        val x = Alert.parse(msg("drive", acts, cp = """{"id":"c1234567","kind":"drive","drive":{"pane":"pdevserv"}}"""))!!
        assertEquals(listOf("allow:once", "allow:session", "refuse"), x.actions.map { it.id })
        assertTrue(x.actions.filter { it.id.startsWith("allow:") }.all { it.biometric })
        assertEquals("""{"id":"c1234567","approve":true,"allow":"once","by":"phone"}""", (Actions.call(x, "allow:once") as ActionCall.Run).post.json)
        assertEquals("""{"id":"c1234567","approve":true,"allow":"session","by":"phone"}""", (Actions.call(x, "allow:session") as ActionCall.Run).post.json)
        assertEquals("""{"id":"c1234567","decline":true,"by":"phone"}""", (Actions.call(x, "refuse") as ActionCall.Post).json)
        assertNull(Actions.call(Alert.parse(msg("ask", a("choice:0", "A")))!!, "allow:once"))
    }

    @Test fun aDriveSaysItsActionAndThePaneByName() {
        val acts = listOf("""{"id":"allow:once","label":"Allow once","biometric":true}""", """{"id":"allow:session","label":"This session","biometric":true}""", a("refuse", "Refuse")).joinToString(",")
        val close = """{"v":1,"type":"alert","id":"cp:c1","kind":"drive","title":"Claude wants to close another tab","body":"Let Claude close \"dev server\" (pane pk3m9q2x)?","detail":"Tilting the hull, on MacBook Pro","checkpoint":{"id":"c1","kind":"drive","drive":{"pane":"pk3m9q2x","action":"close"}},"actions":[$acts]}"""
        val x = Alert.parse(close)!!
        assertEquals("Claude wants to close dev server", x.title)
        assertEquals("", x.body)
        assertEquals(listOf("allow:once" to "Let it close", "refuse" to "Refuse"), x.actions.map { it.id to it.label })
        assertTrue(x.actions.first().biometric)
        val input = Alert.parse(close.replace("\"close\"}", "\"input\"}").replace("Claude wants to close another tab", "Claude wants to type into another tab").replace("Let Claude close", "Let Claude type into"))!!
        assertEquals("Claude wants to type in dev server", input.title)
        assertEquals(listOf("Allow once", "This session", "Refuse"), input.actions.map { it.label })
        assertTrue(!x.title.contains("pk3m9q2x") && !input.title.contains("pk3m9q2x"))
    }

    @Test fun aTypingDriveNamesTheSessionAndPaneFromTheHubAndSaysTheAgentsWords() {
        val acts = listOf("""{"id":"allow:once","label":"Allow once","biometric":true}""", """{"id":"allow:session","label":"This session","biometric":true}""", a("refuse", "Refuse")).joinToString(",")
        val m = """{"v":1,"type":"alert","id":"cp:c2","kind":"drive","title":"Claude, in Tilting the hull, wants to type in dev server","body":"Claude says: The game only listens on this Mac.","detail":"It would type: <Ctrl+C>npm run dev -- --host<Enter>","checkpoint":{"id":"c2","kind":"drive","drive":{"pane":"pk3m9q2x","action":"input","name":"dev server","session":"Tilting the hull","reason":"The game only listens on this Mac."}},"actions":[$acts]}"""
        val x = Alert.parse(m)!!
        assertEquals("Claude, in Tilting the hull, wants to type in dev server", x.title)
        assertEquals("Claude says: The game only listens on this Mac.", x.body)
        assertEquals("It would type: <Ctrl+C>npm run dev -- --host<Enter>", x.detail)
        assertEquals(listOf("Allow once", "This session", "Refuse"), x.actions.map { it.label })
        val close = Alert.parse(m.replace("\"input\",\"name\"", "\"close\",\"name\"").replace("type in dev server", "close dev server"))!!
        assertEquals(listOf("allow:once" to "Let it close", "refuse" to "Refuse"), close.actions.map { it.id to it.label })
        // An older hub, without the names: the session and the agent's words from the fields.
        val old = Drive.of("input", "Claude wants to type into another tab", "<Enter>", null, "Tilting the hull", "Because.")
        assertEquals("Tilting the hull wants to type in another tab", old.title)
        assertEquals("Claude says: Because.", old.says)
        // A hub that knows no name for the pane: its title is the daemon's, its body the agent's words.
        val plain = Drive.of("input", "Let the agent in pane pabc1234 type into \"dev server\" (pane pdef5678)?", "Claude says: Because.", null, "Phone preview", "Because.", "claude")
        assertEquals("Phone preview wants to type in dev server", plain.title)
        assertEquals("Claude says: Because.", plain.body)
        assertEquals(null, plain.says)
    }

    @Test fun aPickShowsCompareAndNotNowAndKeepsItsPictures() {
        val vs = """{"id":"c1234567","kind":"pick","variants":[{"label":"Level","type":"image","url":"/api/checkpoints/c1234567/variants/0"},{"label":"Tilt with the slope","type":"image","url":"/api/checkpoints/c1234567/variants/1"},{"label":"Page","type":"html","url":"/api/checkpoints/c1234567/variants/2"}]}"""
        val x = Alert.parse(msg("pick", listOf(a("pick:0", "Level"), a("pick:1", "Tilt with the slope"), a("open", "Open")).joinToString(","), cp = vs))!!
        assertEquals(listOf("open", "later"), x.actions.map { it.id })
        assertEquals(listOf("Compare", "Not now"), x.actions.map { it.label })
        assertEquals(3, x.variants.size)
        assertEquals("/api/checkpoints/c1234567/variants/1", x.variants[1].url)
        assertTrue(Actions.call(x, "open") is ActionCall.Open)
        assertTrue(Actions.call(x, "later") is ActionCall.Later)
        assertEquals("""{"id":"c1234567","pick":{"label":"Tilt with the slope"},"by":"phone"}""", (Actions.call(x, "pick:1") as ActionCall.Post).json)
        assertNull(Actions.call(x, "pick:7"))
    }

    @Test fun aSavedDecisionIsUndoneByItsId() {
        val x = Alert.parse("""{"v":1,"type":"alert","id":"dec:dk4x34fg","kind":"decision","title":"Saved your decision","body":"Tilt half as much.","detail":"Claude recorded it.","decision":{"id":"dk4x34fg","undo_until":"2026-11-07T10:01:00.000Z"},"actions":[{"id":"undo","label":"Undo"}],"reply":null}""")!!
        assertEquals(listOf("undo"), x.actions.map { it.id })
        val c = Actions.call(x, "undo") as ActionCall.Post
        assertEquals("/api/decisions/undo", c.path)
        assertEquals("""{"id":"dk4x34fg"}""", c.json)
    }

    @Test fun theConnectionLineCountsSessions() {
        val s = """{"projects":[{"machine":null,"sessions":[{"state":"working"},{"state":"dialog"}]},{"machine":"devbox","sessions":[{"state":"idle","words":{"state":"work"}},{"state":"asked"},{"state":"idle"}]}]}"""
        assertEquals("Linked to Studio Mac and devbox. 2 sessions working, 2 need you.", ConnectionService.status("Studio Mac", s))
        // A working session whose agent waits on an open checkpoint needs you.
        val cp = """{"projects":[{"sessions":[{"surfaceId":"ravenry:pa","state":"working"},{"surfaceId":"ravenry:pb","state":"working"}]}],"checkpoints":[{"state":"open","surfaceId":"ravenry:pa"},{"state":"answered","surfaceId":"ravenry:pb"}]}"""
        assertEquals("Linked to Studio Mac. 1 session working, 1 need you.", ConnectionService.status("Studio Mac", cp))
    }
}
