package dev.ravenry.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class AlertColorTest {
    @Test fun theColoursAreTheBoardsTokens() {
        // Gradle runs unit tests in apps/android/app.
        val tokens = File("../../../shared/tokens/tokens.json").readText()
        val dark = tokens.substringAfter("\"dark\"")
        fun token(name: String) = Regex("\"$name\":\\s*\"#([0-9A-Fa-f]{6})\"").find(dark)!!.groupValues[1].toLong(16).toInt() or 0xFF000000.toInt()
        assertEquals(token("you"), AlertColor.YOU)
        assertEquals(token("ok"), AlertColor.OK)
    }
}
