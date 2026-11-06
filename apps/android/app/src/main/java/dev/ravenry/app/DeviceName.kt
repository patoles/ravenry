package dev.ravenry.app

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
