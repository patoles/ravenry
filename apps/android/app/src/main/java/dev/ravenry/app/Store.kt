package dev.ravenry.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The computer this phone is paired with, and this device's token. */
data class Paired(
    val hubName: String,
    val hosts: List<String>,
    val port: Int,
    val pin: String,
    val token: String,
    val deviceId: String,
    val deviceName: String,
    /** The host that answered last, tried first. */
    val lastHost: String? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("hubName", hubName).put("hosts", JSONArray(hosts)).put("port", port).put("pin", pin)
        .put("token", token).put("deviceId", deviceId).put("deviceName", deviceName).put("lastHost", lastHost)

    companion object {
        fun fromJson(o: JSONObject) = Paired(
            o.getString("hubName"),
            List(o.getJSONArray("hosts").length()) { o.getJSONArray("hosts").getString(it) },
            o.getInt("port"), o.getString("pin"), o.getString("token"),
            o.getString("deviceId"), o.getString("deviceName"),
            o.optString("lastHost").takeIf { it.isNotEmpty() && it != "null" },
        )
    }
}

/**
 * The pairing, kept encrypted with a key that never leaves the Android
 * Keystore. A backup or another app reading the preferences file gets only
 * ciphertext.
 */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("ravenry", Context.MODE_PRIVATE)

    @Volatile private var cached: Paired? = null

    fun paired(): Paired? {
        cached?.let { return it }
        val blob = prefs.getString(KEY, null) ?: return null
        return runCatching { Paired.fromJson(JSONObject(decrypt(blob))) }.getOrNull().also { cached = it }
    }

    fun save(p: Paired) {
        prefs.edit().putString(KEY, encrypt(p.toJson().toString())).apply()
        cached = p
    }

    fun rememberHost(host: String) {
        val p = paired() ?: return
        if (p.lastHost != host) save(p.copy(lastHost = host))
    }

    fun clear() {
        prefs.edit().remove(KEY).remove(SEEN).apply()
        cached = null
    }

    /**
     * Pairings signed out on this phone whose computer has not heard yet:
     * Sign out changes the screen at once, and the unpair goes out in the
     * background until the computer answers (Revokes). Kept encrypted, as
     * the pairing is.
     */
    fun revokes(): List<Paired> {
        val blob = prefs.getString(REVOKES, null) ?: return emptyList()
        return runCatching { val a = JSONArray(decrypt(blob)); List(a.length()) { Paired.fromJson(a.getJSONObject(it)) } }.getOrDefault(emptyList())
    }

    @Synchronized fun addRevoke(p: Paired) = saveRevokes(revokes().filter { it.token != p.token } + p)

    @Synchronized fun dropRevoke(token: String) = saveRevokes(revokes().filter { it.token != token })

    private fun saveRevokes(list: List<Paired>) {
        if (list.isEmpty()) prefs.edit().remove(REVOKES).apply()
        else prefs.edit().putString(REVOKES, encrypt(JSONArray(list.map { it.toJson() }).toString())).apply()
    }

    /** Alert ids already drawn, so push and the live stream show each once. */
    fun seen(id: String): Boolean {
        val list = (prefs.getString(SEEN, "") ?: "").split('\n').filter { it.isNotEmpty() }
        if (id in list) return true
        prefs.edit().putString(SEEN, (list.takeLast(199) + id).joinToString("\n")).apply()
        return false
    }

    /** Alerts by push turned off in Settings (the target is then `none`). */
    var pushOff: Boolean
        get() = prefs.getBoolean("pushOff", false)
        set(v) { prefs.edit().putBoolean("pushOff", v).apply() }

    /** Stay connected (the foreground service holding the live stream); on by default. */
    var stayConnected: Boolean
        get() = prefs.getBoolean("stayConnected", true)
        set(v) { prefs.edit().putBoolean("stayConnected", v).apply() }

    var notificationsAsked: Boolean
        get() = prefs.getBoolean("notificationsAsked", false)
        set(v) { prefs.edit().putBoolean("notificationsAsked", v).apply() }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return g.generateKey()
    }

    private fun encrypt(text: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(text.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val b = Base64.decode(blob, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        return String(c.doFinal(b, 12, b.size - 12))
    }

    companion object {
        private const val KEY = "paired"
        private const val SEEN = "seen"
        private const val REVOKES = "revokes"
        private const val ALIAS = "ravenry-store"

        @Volatile private var one: Store? = null
        fun get(context: Context): Store = one ?: synchronized(this) { one ?: Store(context.applicationContext).also { one = it } }
    }
}
