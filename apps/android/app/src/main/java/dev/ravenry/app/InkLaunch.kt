package dev.ravenry.app

import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.PathInterpolator
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.PathParser
import org.json.JSONObject
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max

/**
 * The launch (docs/PHONE.md, The launch; the approved Ink, variant A). On a
 * cold start the system's splash plays the Ink (res/drawable/ink_splash.xml,
 * tools/ink-avd.mjs) for its 1 s while the app connects; then this view holds
 * the splash's last frame, exactly where the splash drew it, until the board
 * has drawn its top bar (board.js says where the bar's mark is: ready()), and
 * flies the mark on an arc to the bar's mark while the board is revealed from
 * that point (a soft-edged circle). When the Mac takes longer: the same
 * drawing, "Reaching your Mac..." after 1.4 s, the eye breathing; when it
 * gives up, the reason words with Try again. A warm start has none of it;
 * with the phone's animations off, the still mark and the board at once;
 * Android 8 to 11 show the still mark (the window's background) and the exit
 * still plays.
 */
class InkLaunch private constructor(private val activity: Activity, private val web: WebView, private val retry: () -> Unit, private val why: () -> String) {
    /** The launch's start: the process's (the system shows the splash as it starts it). */
    private val start = android.os.Process.getStartUptimeMillis()
    private val animationsOff = Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    private var hold: HoldView? = null
        private set
    private var target: JSONObject? = null
    private var splashDone = false
    private var exiting = false

    /** The board drew its top bar: where its mark is (CSS px in the page, and the page's dpr). */
    fun ready(o: JSONObject) {
        if (target != null) return
        target = o
        Log.i(TAG, "board ready at ${SystemClock.uptimeMillis() - start} ms")
        if (splashDone) exit()
    }

    /** The Mac did not answer: the reason words and Try again, in place of the hold's words. */
    fun unreached(words: String) {
        if (target != null) return
        gaveUp = true
        hold?.unreached(words)
    }

    private var gaveUp = false

    /** The Mac answers again while the hold said it did not: the board loads afresh (its first load may have failed). */
    fun answered() {
        if (hold == null || target != null || !gaveUp) return
        gaveUp = false
        hold?.reaching()
        web.reload()
    }

    private fun attach(cx: Float, cy: Float, iconPx: Float) {
        if (hold != null) return
        val decor = activity.window.decorView as ViewGroup
        val h = HoldView(activity, cx, cy, iconPx, start) { gaveUp = false; retry(); web.reload() }
        decor.addView(h, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        hold = h
        // A Mac that does not answer in 12 s: why, and Try again (the hold stays until the board is there).
        h.postDelayed({ if (!exiting && hold != null) { Log.i(TAG, "gave up at ${SystemClock.uptimeMillis() - start} ms"); unreached(why()) } }, 12_000)
    }

    /** The splash ended (or, on Android 8 to 11, the window's still mark is up): exit now if the board is ready. */
    private fun splashEnded() {
        splashDone = true
        // Holding from here: the eye breathes (from its full colour, as the splash left it).
        if (!animationsOff && target == null) hold?.breathe()
        Log.i(TAG, "splash ended at ${SystemClock.uptimeMillis() - start} ms")
        if (target != null) exit()
    }

    private fun exit() {
        val h = hold ?: return
        val t = target ?: return
        if (exiting) return
        exiting = true
        // Animations off: the board at once, a few frames on (the page's first composite, under the mark).
        if (animationsOff) { h.postOnAnimation { h.postOnAnimation { h.postOnAnimation { remove() } } }; return }
        val dpr = t.optDouble("dpr", 1.0).toFloat()
        val loc = IntArray(2); web.getLocationInWindow(loc)
        // The bar's mark: a 26 px svg of viewBox 100, its glyph at translate(4.77 -2.10) scale(0.8954).
        val k = t.optDouble("w", 26.0).toFloat() / 100f
        val tx = loc[0] + (t.optDouble("x").toFloat() + k * (4.77f + 0.8954f * GC_X)) * dpr
        val ty = loc[1] + (t.optDouble("y").toFloat() + k * (-2.10f + 0.8954f * GC_Y)) * dpr
        val ts = k * 0.8954f * dpr
        val box = floatArrayOf(loc[0] + t.optDouble("x").toFloat() * dpr, loc[1] + t.optDouble("y").toFloat() * dpr, t.optDouble("w").toFloat() * dpr, t.optDouble("h").toFloat() * dpr)
        Log.i(TAG, "exit from ${h.cx},${h.cy} to $tx,$ty at ${SystemClock.uptimeMillis() - start} ms")
        h.exit(tx, ty, ts, box, 110f * dpr, web) { remove(); Log.i(TAG, "exit done at ${SystemClock.uptimeMillis() - start} ms") }
    }

    private fun remove() {
        val h = hold ?: return
        hold = null
        plainWindow(activity)
        (h.parent as? ViewGroup)?.removeView(h)
    }

    companion object {
        const val TAG = "RavenryInk"
        const val GC_X = 50.5f
        const val GC_Y = 58.5f
        /** dp per mark unit in the 288 dp splash icon (tools/ink-avd.mjs S). */
        const val S = 1.55f

        /** The window's own colour from here (the launch theme's background is the still mark). */
        fun plainWindow(activity: Activity) = activity.window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(ContextCompat.getColor(activity, R.color.win)))

        /** Once per process: a warm start shows nothing. */
        @Volatile private var coldDone = false

        /** Another screen of the app came first (pairing): the board after it is no launch. */
        fun markWarm() { coldDone = true }

        /**
         * Before the activity's first frame. Returns the launch on a cold start,
         * null otherwise (the splash then goes at the first frame).
         */
        fun begin(activity: Activity, content: View, web: WebView, retry: () -> Unit, why: () -> String): InkLaunch? {
            val cold = !coldDone
            coldDone = true
            if (!cold) {
                Log.i(TAG, "warm start: no launch")
                plainWindow(activity)
                if (Build.VERSION.SDK_INT >= 31) activity.splashScreen.setOnExitAnimationListener { it.remove() }
                return null
            }
            val ink = InkLaunch(activity, web, retry, why)
            Log.i(TAG, "cold start, api ${Build.VERSION.SDK_INT}, animations ${if (ink.animationsOff) "off" else "on"}")
            val density = activity.resources.displayMetrics.density
            // The hold is there from the app's first frame, under the splash
            // (centred, at the splash icon's 288 dp), so nothing blinks when the splash goes.
            ink.attach(-1f, -1f, 288 * density)
            if (Build.VERSION.SDK_INT >= 31) {
                // The splash stays for its 1 s (the Ink plays whole), then exits into the hold.
                val until = ink.start + if (ink.animationsOff) 0 else 1000
                content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
                    override fun onPreDraw(): Boolean {
                        if (SystemClock.uptimeMillis() < until) { content.postInvalidateOnAnimation(); return false }
                        content.viewTreeObserver.removeOnPreDrawListener(this)
                        return true
                    }
                })
                activity.splashScreen.setOnExitAnimationListener { v ->
                    // Exactly where the splash drew it: its icon view is the 192 dp
                    // circle, the 288 dp drawable drawn 1.5 times that (measured on a recording).
                    val icon = v.iconView
                    if (icon != null && icon.width > 0) {
                        val at = IntArray(2)
                        icon.getLocationInWindow(at)
                        ink.hold?.place(at[0] + icon.width / 2f, at[1] + icon.height / 2f, icon.width * 1.5f)
                    }
                    // Gone once the hold under it has drawn (two frames): never a frame with neither.
                    val h = ink.hold
                    if (h != null) h.postOnAnimation { h.postOnAnimation { v.remove() } } else v.remove()
                    ink.splashEnded()
                }
            } else {
                // Android 8 to 11: the window's background is the still mark, centred; the hold draws it in the same place.
                content.post { ink.splashEnded() }
            }
            return ink
        }
    }
}

/** The splash's last frame held, the hold's words, and the exit (drawn in this view, over the board). */
private class HoldView(context: Context, var cx: Float, var cy: Float, iconPx: Float, private val start: Long, private val retry: () -> Unit) : FrameLayout(context) {
    private val win = ContextCompat.getColor(context, R.color.win)
    private val ink = ContextCompat.getColor(context, R.color.tx)
    private val eye = ContextCompat.getColor(context, R.color.work)
    private val body = PathParser.createPathFromPathData("M95 34 C89 28 82 24 75 23 C66 21 58 24 54 30 C50 36 46 40 40 46 C32 54 24 64 18 74 L6 92 L20 94 L28 84 C36 80 48 78 56 76 C68 72 76 62 76 52 C76 46 74 43 78 40 C84 37 90 36 95 34 Z")
    private val legs = PathParser.createPathFromPathData("M50 74 h5 v12 h-5 Z M60 72 h5 v14 h-5 Z M34 85 H86 a3 3 0 0 1 0 6 H34 a3 3 0 0 1 0 -6 Z")
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bg = Paint()
    /** px per mark unit now, and at the start (the splash's). */
    private var scale = iconPx / 288f * InkLaunch.S
    /** Centred in the view until the splash says where (cx < 0). */
    private var centred = cx < 0
    private var eyeAlpha = 1f
    private var glow = 0.18f
    private var hole = 0f
    private var feather = 1f
    private var holeX = 0f
    private var holeY = 0f
    private var cover: FloatArray? = null
    private var breath: ValueAnimator? = null
    private var frames = 0
    private var firstU = 0f
    private val words = TextView(context).apply {
        text = context.getString(R.string.reaching)
        setTextColor(ContextCompat.getColor(context, R.color.tx2))
        textSize = 16f
        gravity = Gravity.CENTER
        alpha = 0f
    }
    private val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }

    init {
        setWillNotDraw(false)
        isClickable = true
        column.addView(words)
        val d = resources.displayMetrics.density
        addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = (max(0f, cy) + 104 * d).toInt(); leftMargin = (40 * d).toInt(); rightMargin = (40 * d).toInt() })
        // "Reaching your Mac..." only after 1.4 s from the launch.
        postDelayed({ if (hole == 0f) { words.animate().alpha(1f).setDuration(300).start(); Log.i(InkLaunch.TAG, "hold words at ${SystemClock.uptimeMillis() - start} ms") } }, max(0L, 1400L - (SystemClock.uptimeMillis() - start)))
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        super.onSizeChanged(w, h, ow, oh)
        if (centred) { cx = w / 2f; cy = h / 2f; moveWords() }
    }

    /** Where the splash drew the mark (its centre in the window, its 288 dp box in px). */
    fun place(x: Float, y: Float, iconPx: Float) {
        centred = false
        val at = IntArray(2); getLocationInWindow(at)
        cx = x - at[0]; cy = y - at[1]; scale = iconPx / 288f * InkLaunch.S
        moveWords(); invalidate()
    }

    private fun moveWords() {
        val lp = column.layoutParams as? LayoutParams ?: return
        lp.topMargin = (cy + 104 * resources.displayMetrics.density).toInt()
        column.layoutParams = lp
    }

    /** The eye breathing while it holds (1.8 s a breath). */
    fun breathe() {
        breath = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1800; repeatCount = ValueAnimator.INFINITE; startDelay = 0
            addUpdateListener { val b = 0.62f + 0.38f * kotlin.math.cos(2 * Math.PI * (it.animatedValue as Float)).toFloat(); eyeAlpha = b; glow = 0.18f * b; invalidate() }
            start()
        }
    }

    fun reaching() {
        words.text = context.getString(R.string.reaching)
        while (column.childCount > 1) column.removeViewAt(1)
    }

    fun unreached(text: String) {
        words.text = text
        words.animate().alpha(1f).setDuration(200).start()
        if (column.childCount < 2) {
            val d = resources.displayMetrics.density
            // The board's blue pill (the mockup's Try again), not a stock button.
            val b = TextView(context).apply {
                setText(R.string.try_again)
                setTextColor(Color.WHITE)
                textSize = 15f
                typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
                gravity = Gravity.CENTER
                minHeight = (44 * d).toInt()
                setPadding((22 * d).toInt(), 0, (22 * d).toInt(), 0)
                background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = 22 * d; setColor(eye) }
                isClickable = true; isFocusable = true
                contentDescription = context.getString(R.string.try_again)
                setOnClickListener { words.text = context.getString(R.string.reaching); column.removeView(this); retry() }
            }
            column.addView(b, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = (22 * resources.displayMetrics.density).toInt() })
        }
    }

    fun exit(tx: Float, ty: Float, ts: Float, box: FloatArray, feather: Float, web: WebView, done: () -> Unit) {
        breath?.cancel(); eyeAlpha = 1f
        words.animate().alpha(0f).setDuration(120).start()
        column.animate().alpha(0f).setDuration(120).start()
        isClickable = false
        val sx = cx; val sy = cy; val s0 = scale
        // The arc's control point, as the mockup's (250, 120) of 412 x 915.
        val qx = width * 250f / 412f; val qy = height * 120f / 915f
        val maxR = hypot(max(tx, width - tx), max(ty, height - ty)) + feather
        val reveal = PathInterpolator(0.4f, 0f, 0.2f, 1f)
        val fly = PathInterpolator(0.3f, 0f, 0.1f, 1f)
        this.feather = feather; holeX = tx; holeY = ty; cover = box
        // The first frames with the board showing through are the heavy ones
        // (the page composited at last): drawn first with the hole closed, so
        // the flight's clock starts once frames flow and none of it is skipped.
        hole = 0.5f
        invalidate()
        val anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 350
            addUpdateListener {
                val u = it.animatedValue as Float
                if (frames == 0) firstU = u
                val k = fly.getInterpolation(u); val q = 1 - k
                cx = q * q * sx + 2 * q * k * qx + k * k * tx
                cy = q * q * sy + 2 * q * k * qy + k * k * ty
                scale = exp(ln(s0) + (ln(ts) - ln(s0)) * k)
                glow = 0.18f * (1 - u)
                hole = max(1f, maxR * reveal.getInterpolation(u))
                frames++
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) { Log.i(InkLaunch.TAG, "exit: $frames frames (the first at ${"%.2f".format(firstU)}), the mark at ${cx.toInt()},${cy.toInt()} scale ${"%.2f".format(scale)} (target $tx,$ty scale ${"%.2f".format(ts)})"); done() }
            })
        }
        postOnAnimation { postOnAnimation { postOnAnimation { anim.start() } } }
    }

    override fun onDraw(c: Canvas) {
        // The window's colour, with the board shown through a soft-edged circle while it exits.
        if (hole <= 0f) c.drawColor(win)
        else {
            val r = hole
            val inner = ((r - feather) / r).coerceIn(0f, 0.999f)
            bg.shader = RadialGradient(holeX, holeY, r, intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, win), floatArrayOf(0f, inner, 1f), Shader.TileMode.CLAMP)
            c.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bg)
            // The bar's own mark stays hidden until the flying one lands on it.
            cover?.let { b -> fill.shader = null; fill.color = win; fill.alpha = 255; c.drawRect(b[0] - 2, b[1] - 2, b[0] + b[2] + 2, b[1] + b[3] + 2, fill) }
        }
        c.save()
        c.translate(cx, cy); c.scale(scale, scale); c.translate(-InkLaunch.GC_X, -InkLaunch.GC_Y)
        fill.shader = null
        fill.color = ink; c.drawPath(body, fill); c.drawPath(legs, fill)
        fill.color = eye
        fill.alpha = (255 * glow * 0.45f).toInt(); c.drawCircle(65f, 32f, 6.5f * 2.3f, fill)
        fill.alpha = (255 * glow).toInt(); c.drawCircle(65f, 32f, 6.5f * 1.5f, fill)
        fill.alpha = (255 * eyeAlpha).toInt(); c.drawCircle(65f, 32f, 6.5f, fill)
        c.restore()
    }
}
