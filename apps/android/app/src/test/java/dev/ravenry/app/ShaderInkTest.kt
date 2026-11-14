package dev.ravenry.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The launch's Ink on Android 13+ (ShaderInk): the Mac's geometry, the weak-GPU guard, where the mark lands. */
class ShaderInkTest {
    @Test fun theRavenIsTheMacsPolygon() {
        // Gradle runs unit tests in apps/android/app.
        val swift = File("../../macos/Sources/RavenryMac/Shaders.swift").readText()
        val macBody = Regex("static let ravenBody = \"([^\"]+)\"").find(swift)!!.groupValues[1]
        val kt = File("src/main/java/dev/ravenry/app/ShaderInk.kt").readText()
        assertTrue("the same path as Shaders.swift ravenBody", kt.contains("\"$macBody\""))
        // M, 3 L and 8 curves of 8 pieces; the last point (the M again) left out.
        assertEquals(67, ShaderInk.N)
        assertEquals(95f, ShaderInk.POLY[0], 1e-4f)
        assertEquals(34f, ShaderInk.POLY[1], 1e-4f)
        for (i in ShaderInk.POLY.indices) assertTrue("inside the glyph's 100 box", ShaderInk.POLY[i] in 0f..100f)
    }

    @Test fun theShaderDeclaresThePolygonAndTheMacsClock() {
        val a = ShaderInk.AGSL
        assertTrue(a.contains("uniform float2 poly[67];"))
        assertTrue(a.contains("const int N = 67;"))
        // 3.4 s, the mark flying at 2.15 s (the Mac's inkBody), where it holds for the board.
        assertEquals(3.4, ShaderInk.DURATION, 0.0)
        assertEquals(2.15, ShaderInk.HOLD_AT, 0.0)
        assertTrue(a.contains("inOut((t - 2.15) / 0.75)"))
    }

    @Test fun aGpuOverTheBudgetFallsBack() {
        assertFalse("the emulator's 18 ms", InkGuard.tooSlow(listOf(18.0, 18.2, 17.9, 18.1, 18.0)))
        assertTrue("a weak GPU", InkGuard.tooSlow(listOf(31.0, 28.0, 35.0, 22.0, 26.0)))
        assertFalse("one slow frame is not the GPU", InkGuard.tooSlow(listOf(12.0, 90.0, 12.0, 13.0, 12.0)))
        assertTrue("most frames over it", InkGuard.tooSlow(listOf(12.0, 25.0, 21.0, 13.0, 24.0)))
        assertFalse("no frames measured: no verdict", InkGuard.tooSlow(emptyList()))
        assertEquals(20.0, InkGuard.BUDGET_MS, 0.0)
        assertEquals(2.5, InkGuard.median(listOf(1.0, 4.0, 2.0, 3.0)), 0.0)
    }

    @Test fun theMarkLandsOnTheBarsMark() {
        // The bar's 26 px mark at (16, 10) CSS px, dpr 2.625, the WebView 63 px down the window.
        val t = JSONObject("""{"x":16,"y":10,"w":26,"h":26,"dpr":2.625}""")
        val (m, box) = InkLaunch.barMark(t, 0f, 63f)
        val k = 0.26f
        assertEquals((16 + k * (4.77f + 0.8954f * 50.5f)) * 2.625f, m[0], 1e-3f)
        assertEquals(63 + (10 + k * (-2.10f + 0.8954f * 58.5f)) * 2.625f, m[1], 1e-3f)
        assertEquals(k * 0.8954f * 2.625f, m[2], 1e-5f)
        assertEquals(42f, box[0], 1e-3f)
        assertEquals(63 + 26.25f, box[1], 1e-3f)
        assertEquals(68.25f, box[2], 1e-3f)
    }
}
