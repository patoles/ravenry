package dev.ravenry.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings

// The name the person gave this phone, as the Mac's phone card shows it:
// the system's device name (Settings, About phone), then Bluetooth's name,
// then the maker and model as the last fallback. Build.MODEL alone is a
// code like "SM-F731B" that nobody would recognise.
object DeviceName {
    fun of(context: Context): String {
        val cr = context.contentResolver
        val named = listOf(
            runCatching { Settings.Global.getString(cr, Settings.Global.DEVICE_NAME) }.getOrNull(),
            runCatching { Settings.Secure.getString(cr, "bluetooth_name") }.getOrNull(),
        ).firstOrNull { !it.isNullOrBlank() }
        return named?.trim()?.take(60) ?: fallback()
    }

    private fun fallback(): String {
        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.orEmpty()
        return when {
            model.startsWith(maker, ignoreCase = true) -> model
            maker.isEmpty() -> model.ifEmpty { "Android phone" }
            else -> "$maker $model"
        }
    }
}

/**
 * This install's id (docs/PHONE.md section 3, "The same device again"):
 * from ANDROID_ID (PairBody.installFrom), so a reinstall pairs again as the
 * same phone and the Mac takes over its row instead of adding one; else a
 * random id kept in the app's own storage (never backed up: the manifest).
 */
object InstallId {
    // ANDROID_ID is per app signing key here, and only its hash goes to the person's own Mac.
    @SuppressLint("HardwareIds")
    fun of(context: Context): String {
        val aid = runCatching { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) }.getOrNull()
        PairBody.installFrom(aid)?.let { return it }
        val prefs = context.getSharedPreferences("ravenry", Context.MODE_PRIVATE)
        prefs.getString("install", null)?.let { return it }
        val id = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })
        prefs.edit().putString("install", id).apply()
        return id
    }
}
