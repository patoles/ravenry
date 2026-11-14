package dev.ravenry.app

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.FrameMetrics
import android.view.Window
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat

/**
 * The Mac's Ink on Android 13 and later (AGSL): the shader of the Mac app
 * (apps/macos Shaders.swift, inkBody), ported line for line, run as a
 * RenderEffect over the app's content (the board's WebView and its bar), so
 * its iChannel0 is the board itself, live, as it loads under the ink. 3.4 s:
 * pale ink gathers into the raven, its eye opens with one ripple, the mark
 * flies to the bar's mark while the board washes in from there.
 *
 * - It never holds the board: the board loads under it from the first frame;
 *   any touch ends it at once and goes on to the board.
 * - The bar's mark is where it lands (InkLaunch.ready). Until the board has
 *   said where, the clock stops at the raven formed (2.15 s), the eye's
 *   ripple and glow running on; the hold's words come as today.
 * - A GPU too weak for it (its first frames over BUDGET_MS each on the GPU,
 *   FrameMetrics): it ends at once with "slow" and InkLaunch plays today's
 *   version (the vector Ink, the hold, the flight) in its place.
 * - Colours are the window's own (win, tx, work), dark or light; in light the
 *   glows are mixed in rather than added (added light on paper is nothing).
 */
@RequiresApi(33)
internal class ShaderInk(private val activity: Activity, private val content: ViewGroup, private val onHold: () -> Unit = {}, private val onEnd: (String) -> Unit) {
    private val shader = RuntimeShader(AGSL)
    private var t0 = -1L
    private var held = 0.0
    private var holdFrom = -1L
    private var landed = false
    private var done = false
    private var frames = 0
    private val freeze: Float? = if (BuildConfig.DEBUG) Settings.Global.getString(activity.contentResolver, "ravenry_ink_at")?.toFloatOrNull() else null
    /** The GPU time a frame may take (ms); a debug build reads `ravenry_ink_budget` so a test can make it trip. */
    private val budget: Double = (if (BuildConfig.DEBUG) Settings.Global.getString(activity.contentResolver, "ravenry_ink_budget")?.toDoubleOrNull() else null) ?: InkGuard.BUDGET_MS
    private val gpuMs = ArrayList<Double>()
    private val totalMs = ArrayList<Double>()
    private var judged = false
    private val metrics = Window.OnFrameMetricsAvailableListener { _, m, _ ->
        if (judged || done || frames == 0) return@OnFrameMetricsAvailableListener
        gpuMs += m.getMetric(FrameMetrics.GPU_DURATION) / 1e6
        totalMs += m.getMetric(FrameMetrics.TOTAL_DURATION) / 1e6
        if (gpuMs.size < InkGuard.SKIP + InkGuard.JUDGE) return@OnFrameMetricsAvailableListener
        judged = true
        val g = InkGuard.median(gpuMs.drop(InkGuard.SKIP)); val tt = InkGuard.median(totalMs.drop(InkGuard.SKIP))
        val slow = InkGuard.tooSlow(gpuMs.drop(InkGuard.SKIP), budget)
        Log.i(InkLaunch.TAG, "shader ink: first frames ${"%.1f".format(g)} ms on the GPU, ${"%.1f".format(tt)} ms in all (budget $budget ms): ${if (slow) "too slow" else "fine"}")
        activity.window.decorView.post { stopMetrics(); if (slow) finish("slow") }
    }
    private var metricsOn = false
    private fun stopMetrics() { if (metricsOn) { metricsOn = false; runCatching { activity.window.removeOnFrameMetricsAvailableListener(metrics) } } }
    private val watcher = object : View(activity) {
        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean { if (e.actionMasked == MotionEvent.ACTION_DOWN) finish("touch"); return false }
    }

    private var unit = 1f

    init {
        val d = activity.resources.displayMetrics.density
        val dark = (activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        fun rgb(id: Int) = ContextCompat.getColor(activity, id).let { floatArrayOf(Color.red(it) / 255f, Color.green(it) / 255f, Color.blue(it) / 255f) }
        shader.setFloatUniform("bg", rgb(R.color.win))
        shader.setFloatUniform("inkC", rgb(R.color.tx))
        shader.setFloatUniform("eyeC", rgb(R.color.work))
        shader.setFloatUniform("sheet", rgb(R.color.win))
        shader.setFloatUniform("dark", if (dark) 1f else 0f)
        shader.setFloatUniform("blurK", d / 2f)
        shader.setFloatUniform("poly", POLY)
        shader.setFloatUniform("icon", -10000f, -10000f, 0f, 0f)
        shader.setFloatUniform("iHeld", 0f)
        unit = InkLaunch.S * d
    }

    fun start() {
        (activity.window.decorView as ViewGroup).addView(watcher, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        Log.i(InkLaunch.TAG, "shader ink: start${if (freeze != null) " (frozen at $freeze s)" else ""}")
        activity.window.addOnFrameMetricsAvailableListener(metrics, Handler(Looper.getMainLooper())); metricsOn = true
        Choreographer.getInstance().postFrameCallback(tick)
    }

    /** Where the bar's mark is, in the window (its glyph centre, px per glyph unit), and its box. */
    fun land(tx: Float, ty: Float, ts: Float, box: FloatArray) {
        val at = IntArray(2); content.getLocationInWindow(at)
        shader.setFloatUniform("markB", tx - at[0], ty - at[1], ts)
        shader.setFloatUniform("icon", box[0] - at[0] + box[2] / 2, box[1] - at[1] + box[3] / 2, box[2] / 2 + 2, 0f)
        landed = true
    }

    private val tick = object : Choreographer.FrameCallback {
        override fun doFrame(now: Long) {
            if (done) return
            if (t0 < 0) t0 = now
            val w = content.width.toFloat(); val h = content.height.toFloat()
            if (w < 2 || h < 2) { Choreographer.getInstance().postFrameCallback(this); return }
            var t = (now - t0) / 1e9 - held
            // Not yet told where the bar's mark is: the raven formed, holding (the eye's glow runs on).
            if (!landed && t >= HOLD_AT) {
                if (holdFrom < 0) { holdFrom = now; Log.i(InkLaunch.TAG, "shader ink: holding for the board"); onHold() }
                held = (now - t0) / 1e9 - HOLD_AT; t = HOLD_AT
            } else if (holdFrom >= 0) { Log.i(InkLaunch.TAG, "shader ink: held ${"%.0f".format(held * 1000)} ms"); holdFrom = -1 }
            freeze?.let { if (t > it) t = it.toDouble() }
            shader.setFloatUniform("iResolution", w, h)
            shader.setFloatUniform("iTime", t.toFloat())
            shader.setFloatUniform("iHeld", held.toFloat())
            shader.setFloatUniform("markA", w / 2, h / 2, unit)
            if (!landed) shader.setFloatUniform("markB", w / 2, h / 2, unit)
            content.setRenderEffect(RenderEffect.createRuntimeShaderEffect(shader, "iChannel0"))
            frames++
            if (t >= DURATION && freeze == null) { finish("done"); return }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    val running get() = !done

    fun finish(why: String) {
        if (done) return
        done = true
        Choreographer.getInstance().removeFrameCallback(tick)
        stopMetrics()
        content.setRenderEffect(null)
        (watcher.parent as? ViewGroup)?.removeView(watcher)
        Log.i(InkLaunch.TAG, "shader ink: ended ($why) after $frames frames, ${"%.0f".format(if (t0 > 0) (System.nanoTime() - t0) / 1e6 else 0.0)} ms")
        onEnd(why)
    }

    companion object {
        const val DURATION = 3.4
        const val HOLD_AT = 2.15

        /** The raven's body as a polygon, each curve in 8 pieces (Shaders.swift flatten(), the mockup's). */
        internal val POLY: FloatArray by lazy {
            val d = "M95 34 C89 28 82 24 75 23 C66 21 58 24 54 30 C50 36 46 40 40 46 C32 54 24 64 18 74 L6 92 L20 94 L28 84 C36 80 48 78 56 76 C68 72 76 62 76 52 C76 46 74 43 78 40 C84 37 90 36 95 34 Z"
            val toks = Regex("[MCLZ]|-?[0-9.]+").findAll(d).map { it.value }.toList()
            val pts = ArrayList<Float>()
            var i = 0; var cmd = ""; var ax = 0f; var ay = 0f
            while (i < toks.size) {
                if (toks[i] in listOf("M", "C", "L", "Z")) { cmd = toks[i]; i++; if (cmd == "Z") continue }
                when (cmd) {
                    "M", "L" -> { ax = toks[i].toFloat(); ay = toks[i + 1].toFloat(); pts += ax; pts += ay; i += 2 }
                    "C" -> {
                        val n = (0 until 6).map { toks[i + it].toFloat() }; i += 6
                        for (s in 1..8) {
                            val u = s / 8f; val v = 1 - u
                            pts += v * v * v * ax + 3 * v * v * u * n[0] + 3 * v * u * u * n[2] + u * u * u * n[4]
                            pts += v * v * v * ay + 3 * v * v * u * n[1] + 3 * v * u * u * n[3] + u * u * u * n[5]
                        }
                        ax = n[4]; ay = n[5]
                    }
                    else -> i++
                }
            }
            if (pts.size > 4 && kotlin.math.abs(pts[0] - pts[pts.size - 2]) < 1e-4 && kotlin.math.abs(pts[1] - pts[pts.size - 1]) < 1e-4) { pts.removeAt(pts.size - 1); pts.removeAt(pts.size - 1) }
            pts.toFloatArray()
        }
        val N: Int get() = POLY.size / 2

        /** Shaders.swift inkBody in AGSL: pixels, top-left origin (VIRT = iResolution, devPx = 1). */
        val AGSL: String by lazy { """
uniform shader iChannel0;
uniform float2 iResolution;
uniform float iTime;
uniform float iHeld;
uniform float3 markA;
uniform float3 markB;
uniform float4 icon;
uniform float3 sheet;
uniform float3 bg;
uniform float3 inkC;
uniform float3 eyeC;
uniform float dark;
uniform float blurK;
uniform float2 poly[$N];
const int N = $N;
const float2 GLYPH_C = float2(50.5, 58.5);

float hash12(float2 p) { float3 p3 = fract(float3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(float2 p) {
  float2 i = floor(p), f = fract(p); float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + float2(1, 0)), u.x), mix(hash12(i + float2(0, 1)), hash12(i + float2(1, 1)), u.x), u.y);
}
float fbm(float2 p) {
  float s = 0.0, a = 0.5; float2x2 m = float2x2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}
float sdPoly(float2 p) {
  float d = dot(p - poly[0], p - poly[0]); float s = 1.0;
  float2 b0 = poly[N - 1];
  for (int i = 0; i < N; i++) {
    float2 a0 = poly[i];
    float2 e = b0 - a0, w = p - a0;
    float2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bool c1 = p.y >= a0.y; bool c2 = p.y < b0.y; bool c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    b0 = a0;
  }
  return s * sqrt(d);
}
float sdBox(float2 p, float2 b) { float2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(float2 p, float2 a, float2 b, float r) { float2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r; }
float sdMark(float2 g) {
  float d = sdPoly(g);
  d = min(d, sdBox(g - float2(52.5, 80.0), float2(2.5, 6.0)));
  d = min(d, sdBox(g - float2(62.5, 79.0), float2(2.5, 7.0)));
  return min(d, sdSeg(g, float2(34.0, 88.0), float2(86.0, 88.0), 3.0));
}
float inOut(float x) { x = clamp(x, 0.0, 1.0); return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5; }
// The board under the ink (premultiplied: what it leaves clear is the window's colour).
float3 board(float2 q) { half4 s = iChannel0.eval(q); return float3(s.rgb) + bg * (1.0 - float(s.a)); }
float3 windowAt(float2 q, float blurPx) {
  float3 s = board(q);
  if (blurPx < 0.05) return s;
  s += board(q + float2(blurPx, blurPx)) + board(q + float2(-blurPx, blurPx));
  s += board(q + float2(blurPx, -blurPx)) + board(q + float2(-blurPx, -blurPx));
  return s / 5.0;
}
float3 glowOn(float3 col, float3 c, float a) { return dark > 0.5 ? col + c * a : mix(col, c, clamp(a, 0.0, 1.0)); }

half4 main(float2 fragCoord) {
  float t = iTime;
  float tE = iTime + iHeld;
  float2 p = fragCoord;

  // Where the mark is: large in the middle, then home to the bar's mark.
  float k = inOut((t - 2.15) / 0.75);
  float2 c = mix(markA.xy, markB.xy, k);
  float u = exp(mix(log(markA.z), log(markB.z), k));
  float2 g = (p - c) / u + GLYPH_C;
  float pxG = 1.0 / u;

  // Ink gathering: the shape seen through a swirl that relaxes to nothing.
  float pA = smoothstep(0.05, 2.0, t);
  float spread = pow(1.0 - pA, 2.0);
  float2 w2 = float2(0.0);
  float2 disp = float2(0.0);
  if (spread > 0.0) {
    float2 q = g * 0.03;
    float2 w1 = float2(fbm(q + float2(0.0, t * 0.35)), fbm(q + float2(5.2, 1.3) - t * 0.3)) - 0.5;
    w2 = float2(fbm(q * 2.1 + 3.0 * w1 + float2(1.7, 9.2) + t * 0.25), fbm(q * 2.1 + 3.0 * w1 + float2(8.3, 2.8) - t * 0.2)) - 0.5;
    disp = (w1 * 1.2 + w2 * 0.9) * 95.0 * spread;
  }
  float d = sdMark(g + disp);
  float soft = max(pxG * 0.7, 20.0 * pow(spread, 0.75));
  float body = 1.0 - smoothstep(-soft, soft, d);
  float halo = 0.0;
  if (spread > 0.0) {
    float wisp = smoothstep(0.40, 0.80, fbm(g * 0.05 + w2 * 4.0 - t * 0.1));
    halo = wisp * exp(-max(d, 0.0) / (4.0 + 28.0 * spread)) * spread;
  }
  float dens = clamp(body + halo * 0.75, 0.0, 1.0) * smoothstep(0.0, 0.8, t);
  float3 inkCol = mix(float3(0.22, 0.38, 0.66), inkC, smoothstep(0.25, 0.9, dens + (1.0 - spread) * 0.6));
  float aura = exp(-max(d, 0.0) / 9.0) * smoothstep(1.3, 2.0, t) * (1.0 - k) * 0.10;

  // The eye opens with one ripple (its own clock: it runs on while the mark waits for the board).
  float eD = length(g - float2(65.0, 32.0)) - 6.5;
  float eyeOn = smoothstep(1.75, 2.1, tE);
  float eye = (1.0 - smoothstep(-pxG * 0.7, pxG * 0.7, eD)) * eyeOn;
  float rT = tE - 1.85;
  float ripple = rT > 0.0 ? exp(-abs(eD - rT * 75.0) / 2.0) * (1.0 - smoothstep(0.0, 0.7, rT)) * 0.5 : 0.0;
  float eGlow = exp(-max(eD, 0.0) / 6.0) * eyeOn * (0.18 + 0.5 * (1.0 - smoothstep(2.1, 2.9, tE)));

  // The board washes in from the bar's mark, like ink spreading in water.
  float3 col = bg;
  if (t > 2.55) {
    float settle = 1.0 - smoothstep(2.55, 3.35, t);
    float2 cp = markB.xy + (p - markB.xy) / (1.0 + 0.02 * settle);
    float3 win = windowAt(cp, settle * 0.8 * blurK);
    // The bar's own mark stays hidden until the flying one lands on it.
    float2 ib = abs(p - icon.xy) - icon.z + icon.w;
    float inIcon = 1.0 - smoothstep(-1.0, 1.0, length(max(ib, 0.0)) + min(max(ib.x, ib.y), 0.0) - icon.w);
    win = mix(win, sheet, inIcon * (1.0 - smoothstep(2.85, 3.05, t)));
    float r = length(p - markB.xy) / iResolution.y;
    float n = fbm(p / iResolution.y * 5.0 + float2(t * 0.2, 0.0));
    float front = (t - 2.55) * 2.4;
    float wash = max(1.0 - smoothstep(front - 0.3, front, r + (n - 0.5) * 0.4), smoothstep(3.15, 3.4, t));
    col = mix(bg, win, wash);
  }

  float markV = 1.0 - smoothstep(3.0, 3.2, t);
  col = mix(col, inkCol, dens * markV);
  col = glowOn(col, inkC, aura * markV);
  col = mix(col, eyeC, eye * markV);
  col = glowOn(col, eyeC, (eGlow + ripple) * markV * 0.55);
  if (t >= 3.4) col = board(p);
  return half4(half3(col), 1.0);
}
""" }
    }
}

/** The weak-GPU guard: the shader's first frames, judged on the GPU's time (pure, for ShaderInkTest). */
internal object InkGuard {
    /** About a 60 Hz frame: over it on the GPU, the ink would stutter, so today's version plays instead. */
    const val BUDGET_MS = 20.0
    /** The first frames left out (the shader compiled, the board's first composite). */
    const val SKIP = 3
    /** Then this many frames judged. */
    const val JUDGE = 5

    fun median(v: List<Double>): Double {
        if (v.isEmpty()) return 0.0
        val s = v.sorted(); val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2
    }

    /** Too slow when the frames judged take over the budget each, as a rule (their median): one slow frame is not the GPU. */
    fun tooSlow(gpuMs: List<Double>, budget: Double = BUDGET_MS) = gpuMs.isNotEmpty() && median(gpuMs) > budget
}
