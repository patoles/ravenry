package dev.ravenry.app

import android.os.Bundle
import android.widget.Toast
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/** A fingerprint before every Run (docs/PHONE.md section 5). It cannot be turned off. */
object Biometrics {
    /** Null when a strong biometric is set up, else why Run cannot ask for one. */
    fun unavailable(activity: FragmentActivity): String? = when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
        BiometricManager.BIOMETRIC_SUCCESS -> null
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> activity.getString(R.string.no_fingerprint)
        else -> activity.getString(R.string.no_fingerprint_hw)
    }

    fun ask(activity: FragmentActivity, title: String, subtitle: String?, done: (Boolean, String?) -> Unit) {
        unavailable(activity)?.let { done(false, it); return }
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(true, null)
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = done(false, errString.toString())
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .apply { if (!subtitle.isNullOrBlank()) setSubtitle(subtitle) }
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setNegativeButtonText(activity.getString(R.string.cancel))
            .setConfirmationRequired(false)
            .build()
        prompt.authenticate(info)
    }
}

/** Run (or Allow on a drive) from the shade: a see-through screen that only shows the fingerprint prompt, then answers. */
class RunActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val a = Alert.parse(intent.getStringExtra(Notifier.EXTRA_ALERT) ?: "") ?: return finish()
        val id = intent.getStringExtra(Notifier.EXTRA_ACTION) ?: "run"
        val call = Actions.call(a, id) as? ActionCall.Run ?: return finish()
        if (savedInstanceState != null) return
        val label = a.actions.firstOrNull { it.id == id }?.label ?: getString(R.string.run)
        Biometrics.ask(this, label, a.body) { ok, error ->
            if (!ok) {
                if (error != null && Biometrics.unavailable(this) != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                finish()
                return@ask
            }
            Hub.io.execute { ActionReceiver.send(applicationContext, a, call.post, label) }
            finish()
        }
    }
}
