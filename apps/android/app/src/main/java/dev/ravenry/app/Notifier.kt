package dev.ravenry.app

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/** Alerts in the shade (docs/PHONE.md section 5). One notification per alert id. */
object Notifier {
    const val NEEDS_YOU = "needs-you"
    const val CONNECTION = "connection"
    const val CONNECTION_ID = 1
    private const val ALERT_ID = 2
    const val EXTRA_ALERT = "dev.ravenry.app.ALERT"
    const val EXTRA_ACTION = "dev.ravenry.app.ACTION"
    const val REPLY_KEY = "reply"
    const val ORANGE = 0xFFFF9F0A.toInt()

    /** A message from push or the live stream: drawn once per id, or a close. */
    fun handle(context: Context, text: String, fromPush: Boolean) {
        val a = Alert.parse(text) ?: return
        if (a.type == "close") { cancel(context, a.id); return }
        if (Store.get(context).seen(a.id)) return
        show(context, a)
    }

    fun cancel(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(id, ALERT_ID)
    }

    private fun flags(mutable: Boolean = false) = PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)

    fun openIntent(context: Context, a: Alert): PendingIntent {
        val i = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_ALERT, a.raw).setAction("open:" + a.id)
        return PendingIntent.getActivity(context, a.id.hashCode(), i, flags())
    }

    private fun actionIntent(context: Context, a: Alert, id: String): PendingIntent {
        if (id == "open") return openIntent(context, a)
        if (id == "run") {
            val i = Intent(context, RunActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_ALERT, a.raw).setAction("run:" + a.id)
            return PendingIntent.getActivity(context, (a.id + id).hashCode(), i, flags())
        }
        val i = Intent(context, ActionReceiver::class.java).putExtra(EXTRA_ALERT, a.raw).putExtra(EXTRA_ACTION, id).setAction("act:" + a.id + ":" + id)
        return PendingIntent.getBroadcast(context, (a.id + id).hashCode(), i, flags(mutable = id == "reply"))
    }

    private fun base(context: Context, a: Alert): NotificationCompat.Builder = NotificationCompat.Builder(context, NEEDS_YOU)
        .setSmallIcon(R.drawable.ic_perch)
        .setColor(ORANGE)
        .setContentTitle(a.title)
        .setSubText(a.projectName)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setContentIntent(openIntent(context, a))
        .setAutoCancel(true)

    fun show(context: Context, a: Alert) {
        val text = SpannableStringBuilder()
        if (a.body.isNotEmpty()) { text.append(a.body); text.setSpan(StyleSpan(Typeface.BOLD), 0, a.body.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        if (a.detail != null) { if (text.isNotEmpty()) text.append(' '); text.append(a.detail) }
        val b = base(context, a).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
        for (act in a.actions) b.addAction(0, act.label, actionIntent(context, a, act.id))
        a.reply?.let { r ->
            val input = RemoteInput.Builder(REPLY_KEY).setLabel(r.hint ?: r.label).build()
            b.addAction(NotificationCompat.Action.Builder(0, r.label, actionIntent(context, a, "reply")).addRemoteInput(input).setAllowGeneratedReplies(false).build())
        }
        post(context, a.id, b.build())
    }

    /** After an action: what was sent, then gone after four seconds; or why it failed, with Open. */
    fun after(context: Context, a: Alert, ok: Boolean, said: String) {
        val b = base(context, a).setContentText(said).setOnlyAlertOnce(true).setSilent(true)
        if (ok) b.setTimeoutAfter(4000) else b.addAction(0, context.getString(R.string.open), openIntent(context, a)).setStyle(NotificationCompat.BigTextStyle().bigText(said))
        post(context, a.id, b.build())
    }

    private fun post(context: Context, id: String, n: Notification) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        try { NotificationManagerCompat.from(context).notify(id, ALERT_ID, n) } catch (_: SecurityException) { }
    }

    fun connection(context: Context, text: String): Notification = NotificationCompat.Builder(context, CONNECTION)
        .setSmallIcon(R.drawable.ic_perch)
        .setColor(0xFF30D158.toInt())
        .setContentTitle(context.getString(R.string.connected))
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), flags()))
        .build()

    fun updateConnection(context: Context, text: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        try { nm.notify(CONNECTION_ID, connection(context, text)) } catch (_: SecurityException) { }
    }
}
