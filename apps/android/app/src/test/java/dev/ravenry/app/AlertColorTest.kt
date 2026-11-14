package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class AlertColorTest {
    private fun kindOf(kind: String, type: String = "alert") =
        Alert.parse("""{"v":1,"type":"$type","id":"x:1","kind":"$kind","title":"T","body":"B","actions":[]}""")!!.kind

    @Test fun aSavedDecisionIsGreen() {
        assertEquals(AlertColor.OK, AlertColor.of(kindOf("decision")))
    }

    @Test fun everythingThatWaitsForYouIsOrange() {
        for (k in listOf("ask", "approve", "secret", "permission", "question", "handback", "gate", "drive", "pick"))
            assertEquals(k, AlertColor.YOU, AlertColor.of(kindOf(k)))
        // A kind this app does not know yet, and the test alert, keep the app's orange.
        assertEquals(AlertColor.YOU, AlertColor.of(kindOf("later-kind")))
        assertEquals(AlertColor.YOU, AlertColor.of(kindOf("test", type = "test")))
    }

    @Test fun theColoursAreTheBoardsTokens() {
        // Gradle runs unit tests in apps/android/app.
        val tokens = File("../../../shared/tokens/tokens.json").readText()
        val dark = tokens.substringAfter("\"dark\"")
        fun token(name: String) = Regex("\"$name\":\\s*\"#([0-9A-Fa-f]{6})\"").find(dark)!!.groupValues[1].toLong(16).toInt() or 0xFF000000.toInt()
        assertEquals(token("you"), AlertColor.YOU)
        assertEquals(token("ok"), AlertColor.OK)
    }
}
