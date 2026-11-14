package dev.ravenry.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The launch's Ink on Android 13+ (ShaderInk): the Mac's geometry, the cuts in its cost, the weak-GPU guard, the run's numbers, where the mark lands. */
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
        // The 67 edges in 9 chunks of 8, the last one filled with edges far off.
        assertTrue(a.contains("uniform float4 edge[72];"))
        assertTrue(a.contains("uniform float4 cbox[9];"))
        assertTrue(a.contains("const int NC = 9;"))
        // 3.4 s, the mark flying at 2.15 s (the Mac's inkBody), where it holds for the board.
        assertEquals(3.4, ShaderInk.DURATION, 0.0)
        assertEquals(2.15, ShaderInk.HOLD_AT, 0.0)
        assertTrue(a.contains("inOut((t - 2.15) / 0.75)"))
    }

    /** The Mac's loop over every edge (Shaders.swift sdPoly), in Kotlin's floats. */
    private fun sdPolyAll(px: Float, py: Float): Float {
        val P = ShaderInk.POLY; val n = ShaderInk.N
        var d = (px - P[0]) * (px - P[0]) + (py - P[1]) * (py - P[1]); var s = 1f
        var bx0 = P[(n - 1) * 2]; var by0 = P[(n - 1) * 2 + 1]
        for (i in 0 until n) {
            val ax = P[i * 2]; val ay = P[i * 2 + 1]
            val ex = bx0 - ax; val ey = by0 - ay; val wx = px - ax; val wy = py - ay
            val h = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).coerceIn(0f, 1f)
            val bx = wx - ex * h; val by = wy - ey * h
            d = minOf(d, bx * bx + by * by)
            val c1 = py >= ay; val c2 = py < by0; val c3 = ex * wy > ey * wx
            if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
            bx0 = ax; by0 = ay
        }
        return s * kotlin.math.sqrt(d)
    }

    /** The shader's sdPoly: chunks no nearer than the nearest edge so far skipped, crossings only where the row passes. */
    private fun sdPolyChunks(px: Float, py: Float): Pair<Float, Int> {
        val E = ShaderInk.EDGES; val B = ShaderInk.CBOX; val ch = ShaderInk.CH
        var d = 1e30f; var measured = 0
        for (c in 0 until ShaderInk.NC) { val vx = E[c * ch * 4] - px; val vy = E[c * ch * 4 + 1] - py; d = minOf(d, vx * vx + vy * vy) }
        var s = 1f
        for (c in 0 until ShaderInk.NC) {
            val qx = maxOf(maxOf(B[c * 4] - px, px - B[c * 4 + 2]), 0f); val qy = maxOf(maxOf(B[c * 4 + 1] - py, py - B[c * 4 + 3]), 0f)
            val near = qx * qx + qy * qy < d
            if (!near && !(py >= B[c * 4 + 1] && py < B[c * 4 + 3])) continue
            for (j in 0 until ch) {
                val i = (c * ch + j) * 4
                val ax = E[i]; val ay = E[i + 1]; val bx0 = E[i + 2]; val by0 = E[i + 3]
                val ex = bx0 - ax; val ey = by0 - ay; val wx = px - ax; val wy = py - ay
                if (near) {
                    val h = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).coerceIn(0f, 1f)
                    val bx = wx - ex * h; val by = wy - ey * h
                    d = minOf(d, bx * bx + by * by); measured++
                }
                val c1 = py >= ay; val c2 = py < by0; val c3 = ex * wy > ey * wx
                if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
            }
        }
        return s * kotlin.math.sqrt(d) to measured
    }

    @Test fun theChunkedOutlineIsTheMacsDistance() {
        // A grid over the glyph and far around it (glyph units), inside points and outside.
        var n = 0; var inside = 0; var measured = 0L
        var y = -250f
        while (y <= 350f) {
            var x = -150f
            while (x <= 250f) {
                val a = sdPolyAll(x, y); val (b, m) = sdPolyChunks(x, y)
                assertEquals("sign at $x,$y", Math.signum(a), Math.signum(b))
                assertEquals("distance at $x,$y", a, b, 1e-4f * maxOf(1f, kotlin.math.abs(a)))
                n++; if (a < 0) inside++; measured += m
                x += 0.7f
            }
            y += 0.9f
        }
        assertTrue("points inside the body: $inside", inside > 1000)
        assertTrue("edges measured per point ${measured.toDouble() / n}: far fewer than 67", measured.toDouble() / n < 20)
    }

    @Test fun theMarksBoxIsNeverNearerThanTheMark() {
        // sdMark >= the distance to GBOX: what the shader skips on it cannot be nearer.
        val gb = ShaderInk.GBOX
        fun sdBox(px: Float, py: Float, bx: Float, by: Float): Float {
            val dx = kotlin.math.abs(px) - bx; val dy = kotlin.math.abs(py) - by
            return kotlin.math.hypot(maxOf(dx, 0f), maxOf(dy, 0f)) + minOf(maxOf(dx, dy), 0f)
        }
        fun sdSeg(px: Float, py: Float): Float { val h = ((px - 34f) / 52f).coerceIn(0f, 1f); return kotlin.math.hypot(px - 34f - 52f * h, py - 88f) - 3f }
        val r = java.util.Random(7)
        repeat(200_000) {
            val x = -100f + r.nextFloat() * 300f; val y = -100f + r.nextFloat() * 300f
            val mark = minOf(minOf(sdPolyAll(x, y), sdBox(x - 52.5f, y - 80f, 2.5f, 6f)), minOf(sdBox(x - 62.5f, y - 79f, 2.5f, 7f), sdSeg(x, y)))
            assertTrue("at $x,$y", mark >= sdBox(x - gb[0], y - gb[1], gb[2], gb[3]) - 1e-3f)
        }
        // The filling edges: horizontal (never crossed) and far off.
        for (i in ShaderInk.N until ShaderInk.NC * ShaderInk.CH) { assertEquals(ShaderInk.EDGES[i * 4 + 1], ShaderInk.EDGES[i * 4 + 3], 0f); assertTrue(ShaderInk.EDGES[i * 4] < -9000f) }
    }

    @Test fun theRunsNumbers() {
        val gpu = listOf(30.0, 40.0, 50.0) + (1..10).map { it.toDouble() }
        // The first 3 left out (the shader compiled): 1..10, median 5.5, p90 9.
        assertEquals("10 frames, median 5.5 ms, p90 9.0 ms (in all median 5.5 ms, p90 9.0 ms)", InkGuard.runStats(gpu, gpu))
        assertEquals(9.0, InkGuard.percentile((1..10).map { it.toDouble() }, 90.0), 0.0)
        assertEquals(10.0, InkGuard.percentile((1..10).map { it.toDouble() }, 100.0), 0.0)
        assertEquals("0 frames, median 0.0 ms, p90 0.0 ms (in all median 0.0 ms, p90 0.0 ms)", InkGuard.runStats(emptyList(), emptyList()))
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
