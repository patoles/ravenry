package dev.ravenry.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/**
 * The colours of the shade: an alert waits for you, orange (token `you`),
 * on the small icon's circle and on stock Android the app's name above it
 * (One UI keeps its own); the connection line is green (token `ok`), as the
 * board draws them (shared/tokens/tokens.json, dark).
 */
object AlertColor {
    const val YOU = 0xFFFF9F0A.toInt()
    const val OK = 0xFF30D158.toInt()
}

/** Alerts in the shade (docs/PHONE.md section 5). One notification per alert id. */
object Notifier {
    const val NEEDS_YOU = "needs-you"
    const val CONNECTION = "connection"
    const val CONNECTION_ID = 1
    private const val ALERT_ID = 2
    private const val SUMMARY_ID = 3
    /** Every alert's group, with this app's own summary (syncSummary). */
    const val ALERTS_GROUP = "dev.ravenry.app.ALERTS"
    const val EXTRA_ALERT = "dev.ravenry.app.ALERT"
    /** The summary's tap: the newest alert in the shade, read when tapped (MainActivity). */
    const val EXTRA_NEWEST = "dev.ravenry.app.NEWEST"
    /** An alert swiped away: the summary follows (ActionReceiver). */
    const val ACTION_SYNC = "dev.ravenry.app.SYNC"
    const val EXTRA_ACTION = "dev.ravenry.app.ACTION"
    const val REPLY_KEY = "reply"

    // Alerts answered from the shade on this phone, with when and whether the
    // hub has closed them since. The hub closes an alert as soon as its answer
    // lands, just before or just after the answer's own reply is back here; a
    // close in the next few seconds leaves the alert to `after`, so the person
    // sees "Sent: ..." for its four seconds instead of the alert vanishing.
    private class Answered(val at: Long) { @Volatile var closed = false }
    private val answered = java.util.concurrent.ConcurrentHashMap<String, Answered>()
    private const val ANSWER_HOLD_MS = 15_000L

    /** An answer to this alert leaves the phone now (ActionReceiver.send). */
    fun answering(id: String) {
        val now = android.os.SystemClock.elapsedRealtime()
        answered.entries.removeIf { now - it.value.at > ANSWER_HOLD_MS }
        answered[id] = Answered(now)
    }

    /** A message from push or the live stream: drawn once per id, or a close. */
    fun handle(context: Context, text: String, fromPush: Boolean) {
        val a = Alert.parse(text) ?: return
        if (a.type == "close") {
            val x = answered[a.id]
            if (x != null && android.os.SystemClock.elapsedRealtime() - x.at < ANSWER_HOLD_MS) { x.closed = true; return }
            cancel(context, a.id); return
        }
        if (Store.get(context).seen(a.id)) return
        show(context, a)
    }

    /** Whether Android shows this app's alerts: its notifications on and the Needs you channel not blocked. */
    fun allowed(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val ch = runCatching { context.getSystemService(NotificationManager::class.java).getNotificationChannel(NEEDS_YOU) }.getOrNull()
        return ch == null || ch.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun cancel(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(id, ALERT_ID)
        syncSummary(context, gone = id)
    }

    private fun flags(mutable: Boolean = false) = PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)

    fun openIntent(context: Context, a: Alert): PendingIntent {
        val i = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_ALERT, a.raw).setAction("open:" + a.id)
        return PendingIntent.getActivity(context, a.id.hashCode(), i, flags())
    }

    private fun actionIntent(context: Context, a: Alert, id: String): PendingIntent {
        if (id == "open") return openIntent(context, a)
        // Run, and Allow on a drive: the fingerprint prompt first.
        if (id == "run" || a.actions.any { it.id == id && it.biometric }) {
            val i = Intent(context, RunActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_ALERT, a.raw).putExtra(EXTRA_ACTION, id).setAction("run:" + a.id + ":" + id)
            return PendingIntent.getActivity(context, (a.id + id).hashCode(), i, flags())
        }
        val i = Intent(context, ActionReceiver::class.java).putExtra(EXTRA_ALERT, a.raw).putExtra(EXTRA_ACTION, id).setAction("act:" + a.id + ":" + id)
        return PendingIntent.getBroadcast(context, (a.id + id).hashCode(), i, flags(mutable = id == "reply"))
    }

    private fun base(context: Context, a: Alert): NotificationCompat.Builder = NotificationCompat.Builder(context, NEEDS_YOU)
        .setSmallIcon(R.drawable.ic_perch)
        .setColor(AlertColor.YOU)
        .setContentTitle(a.title)
        .setSubText(a.projectName)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setContentIntent(openIntent(context, a))
        .setDeleteIntent(PendingIntent.getBroadcast(context, SUMMARY_ID, Intent(context, ActionReceiver::class.java).setAction(ACTION_SYNC), flags()))
        .setAutoCancel(true)
        // One group for every alert, with the app's own summary. Android 16
        // folds alerts that have a group but no summary (each was a group of
        // its own before) under a summary of its own, whose tap opens only
        // the app; this one opens the newest alert's card.
        .setGroup(ALERTS_GROUP)
        // The message itself, so a later snapshot can tell whether it still waits (sweep).
        .addExtras(android.os.Bundle().apply { putString(EXTRA_ALERT, a.raw) })

    /**
     * What a drive would type, its keys drawn as keys: each one bold on a
     * tinted ground ("Ctrl C"), the text between them as it is. The hub
     * split it (hub/public/keys.mjs); nothing is parsed here.
     */
    fun typed(keys: List<KeyPart>): CharSequence {
        val out = SpannableStringBuilder()
        for (p in keys) {
            if (out.isNotEmpty()) out.append(' ')
            val at = out.length
            if (p.key) {
                out.append('\u00A0').append(p.text.replace(' ', '\u00A0')).append('\u00A0')
                out.setSpan(BackgroundColorSpan(KEY_GROUND), at, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(StyleSpan(Typeface.BOLD), at, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            } else out.append(p.text.trim())
        }
        return out
    }
    private const val KEY_GROUND = 0x40808080

    fun show(context: Context, a: Alert) {
        val text = SpannableStringBuilder()
        // A drive's keys come as parts: the hub's line ("[Ctrl C] npm run
        // dev [Enter]") is drawn again with the keys as keys.
        val keyed = a.kind == "drive" && a.keys.isNotEmpty()
        val bodyTyped = keyed && !a.body.contains(" says: ")
        if (bodyTyped) text.append(typed(a.keys))
        else if (a.body.isNotEmpty()) { text.append(a.body); text.setSpan(StyleSpan(Typeface.BOLD), 0, a.body.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        if (a.detail != null) {
            if (text.isNotEmpty()) text.append(' ')
            if (keyed && a.detail.startsWith("It would type: ")) text.append("It would type: ").append(typed(a.keys)) else text.append(a.detail)
        }
        val b = base(context, a).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
        for (act in a.actions) b.addAction(0, act.label, actionIntent(context, a, act.id))
        a.reply?.let { r ->
            val input = RemoteInput.Builder(REPLY_KEY).setLabel(r.hint ?: r.label).build()
            b.addAction(NotificationCompat.Action.Builder(0, r.label, actionIntent(context, a, "reply")).addRemoteInput(input).setAllowGeneratedReplies(false).build())
        }
        if (a.kind == "pick") {
            // "Which tilt reads best? 3 pictures.", then the pictures side by
            // side once they are fetched over the pinned connection.
            val n = a.variants.size
            val words = SpannableStringBuilder()
            val q = a.body.ifEmpty { a.title }
            words.append(q); words.setSpan(StyleSpan(Typeface.BOLD), 0, q.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (n > 0) words.append(' ').append(context.resources.getQuantityString(R.plurals.pictures, n, n))
            b.setContentText(words).setStyle(NotificationCompat.BigTextStyle().bigText(words))
            post(context, a.id, b.build())
            val images = a.variants.filter { it.type == "image" }
            if (images.isNotEmpty()) Hub.io.execute {
                val strip = Pictures.strip(context, images) ?: return@execute
                if (answered.containsKey(a.id)) return@execute
                b.setOnlyAlertOnce(true)
                    .setStyle(NotificationCompat.BigPictureStyle().bigPicture(strip).setSummaryText(words))
                if (isShowing(context, a.id)) post(context, a.id, b.build())
            }
            return
        }
        post(context, a.id, b.build())
    }

    private fun isShowing(context: Context, id: String): Boolean = runCatching {
        context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.tag == id && it.id == ALERT_ID }
    }.getOrDefault(true)

    /** After an action: what was sent, then gone after four seconds; or why it failed, with Open. */
    fun after(context: Context, a: Alert, ok: Boolean, said: String) {
        // Not sent, and closed meanwhile (answered on the computer): nothing waits.
        // Not sent and still open: a later close takes it off as usual.
        if (!ok) { val x = answered.remove(a.id); if (x?.closed == true) { cancel(context, a.id); return } }
        val b = base(context, a).setContentText(said).setOnlyAlertOnce(true).setSilent(true)
        if (ok) { b.setTimeoutAfter(4000); main.postDelayed({ syncSummary(context) }, 4500) } else b.addAction(0, context.getString(R.string.open), openIntent(context, a)).setStyle(NotificationCompat.BigTextStyle().bigText(said))
        post(context, a.id, b.build())
    }

    private fun post(context: Context, id: String, n: Notification) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        try { NotificationManagerCompat.from(context).notify(id, ALERT_ID, n) } catch (_: SecurityException) { return }
        syncSummary(context, posted = n.extras.getString(EXTRA_ALERT)?.let { Alert.parse(it) })
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /**
     * The alerts in the shade, newest first. `posted` was just posted and
     * `gone` just cancelled: Android's list may not show either yet.
     */
    private fun shown(context: Context, posted: Alert? = null, gone: String? = null): List<Alert>? {
        val list = runCatching { context.getSystemService(NotificationManager::class.java).activeNotifications.filter { it.id == ALERT_ID && it.tag != null && it.tag != gone } }.getOrNull() ?: return null
        val rest = list.sortedByDescending { it.postTime }.mapNotNull { n -> n.notification.extras.getString(EXTRA_ALERT)?.let { Alert.parse(it) } }.filter { it.id != posted?.id }
        return listOfNotNull(posted) + rest
    }

    /** The newest alert in the shade, as the hub sent it: what the summary's tap opens. */
    fun newest(context: Context): String? = shown(context)?.firstOrNull()?.raw

    /**
     * The group's summary: there while an alert is, gone with the last one.
     * Its tap (a stack of alerts folded, or Android 16's own folding) opens
     * the newest alert's card, never the app alone. It never rings itself.
     */
    fun syncSummary(context: Context, posted: Alert? = null, gone: String? = null) {
        val all = shown(context, posted, gone) ?: return
        val nm = NotificationManagerCompat.from(context)
        if (all.isEmpty()) { nm.cancel(SUMMARY_ID); return }
        val top = all.first()
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_NEWEST, true).setAction("open:newest")
        val lines = NotificationCompat.InboxStyle()
        all.take(5).forEach { lines.addLine(it.title) }
        val n = NotificationCompat.Builder(context, NEEDS_YOU)
            .setSmallIcon(R.drawable.ic_perch)
            .setColor(AlertColor.YOU)
            .setContentTitle(top.title)
            .setContentText(top.body.ifEmpty { top.title })
            .setStyle(lines)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(ALERTS_GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(PendingIntent.getActivity(context, SUMMARY_ID, open, flags()))
            .build()
        try { nm.notify(SUMMARY_ID, n) } catch (_: SecurityException) { }
    }

    fun connection(context: Context, line: ConnectionService.Line): Notification = NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(R.drawable.ic_perch)
        .setColor(AlertColor.OK)
        .setContentTitle(line.title)
        .setContentText(line.body)
        .setGroup("connection")
        .apply { if (line.body != null) setStyle(NotificationCompat.BigTextStyle().bigText(line.body)) }
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), flags()))
        .build()

    fun updateConnection(context: Context, line: ConnectionService.Line) {
        val nm = context.getSystemService(NotificationManager::class.java)
        try { nm.notify(CONNECTION_ID, connection(context, line)) } catch (_: SecurityException) { }
    }

    /**
     * Takes off every alert whose question no longer waits, from a state
     * snapshot (the live stream's `state`): a checkpoint that is no longer
     * open, a session that left Needs you or is not the one that waits, a
     * plan gate passed. The hub sends a close for each, but a close is lost
     * when the phone heard nothing at that moment (asleep with no push
     * distributor) or the hub restarted in between; the next snapshot puts
     * it right. An alert posted in the last few seconds, or just answered
     * from the shade, is left alone.
     */
    fun sweep(context: Context, json: String) {
        val o = runCatching { org.json.JSONObject(json) }.getOrNull() ?: return
        val shown = runCatching { context.getSystemService(NotificationManager::class.java).activeNotifications.filter { it.id == ALERT_ID && it.tag != null } }.getOrNull() ?: return
        if (shown.isEmpty()) return
        val now = System.currentTimeMillis()
        val waits = Waiting.of(o) ?: return
        for (n in shown) {
            if (now - n.postTime < SWEEP_GRACE_MS) continue
            val x = answered[n.tag]
            if (x != null && android.os.SystemClock.elapsedRealtime() - x.at < ANSWER_HOLD_MS) continue
            val a = n.notification.extras.getString(EXTRA_ALERT)?.let { Alert.parse(it) } ?: continue
            if (!waits.still(a)) cancel(context, n.tag)
        }
    }
    private const val SWEEP_GRACE_MS = 10_000L
}
