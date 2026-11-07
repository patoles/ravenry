package dev.ravenry.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/** A pick's pictures for the shade: fetched over the pinned connection, laid side by side. */
object Pictures {
    private const val HEIGHT = 240
    private const val GAP = 6
    private const val MAX_BYTES = 8 shl 20

    /** One bitmap with every picture at the same height, in order; null when none could be fetched. */
    fun strip(context: Context, variants: List<AlertVariant>): Bitmap? {
        val hub = Hub.get(context) ?: return null
        val pics = variants.take(4).mapNotNull { v ->
            runCatching {
                hub.execute("GET", v.url).use { r ->
                    if (r.code != 200) return@use null
                    val body = r.body ?: return@use null
                    if (body.contentLength() > MAX_BYTES) return@use null
                    val bytes = body.bytes()
                    decode(bytes)
                }
            }.getOrNull()
        }
        if (pics.isEmpty()) return null
        return lay(pics)
    }

    /** A picture decoded at about the strip's height, so a large one never takes the memory of its full size. */
    fun decode(bytes: ByteArray): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        var sample = 1
        while (o.outHeight / (sample * 2) >= HEIGHT) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    fun lay(pics: List<Bitmap>): Bitmap {
        val widths = pics.map { (it.width * HEIGHT / it.height.toFloat()).toInt().coerceAtLeast(1) }
        val out = Bitmap.createBitmap(widths.sum() + GAP * (pics.size - 1), HEIGHT, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        var x = 0f
        pics.forEachIndexed { i, b ->
            val r = RectF(x, 0f, x + widths[i], HEIGHT.toFloat())
            val clip = Path().apply { addRoundRect(r, 10f, 10f, Path.Direction.CW) }
            c.save(); c.clipPath(clip); c.drawBitmap(b, null, r, paint); c.restore()
            x += widths[i] + GAP
        }
        return out
    }
}
