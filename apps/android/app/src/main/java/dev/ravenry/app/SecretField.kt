package dev.ravenry.app

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout

/**
 * The private keyboard (docs/PHONE.md section 7): a native field laid over
 * the secret card's field. Password input, no suggestions, and no
 * personalised learning, so the keyboard keeps nothing. The page never sees
 * what is typed, only how many characters; Send answers the checkpoint from
 * here and forgets the text.
 */
class SecretField(private val context: Context, private val parent: FrameLayout) {
    private var field: EditText? = null
    var checkpoint: String? = null
        private set
    var onCount: (Int) -> Unit = {}
    var onSend: () -> Unit = {}

    val isOpen get() = field != null

    fun open(checkpoint: String, rect: FloatArray, dark: Boolean, size: Float) {
        close()
        this.checkpoint = checkpoint
        val d = context.resources.displayMetrics.density
        val e = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_FULLSCREEN
            if (android.os.Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            isSaveEnabled = false
            setBackgroundColor(Color.TRANSPARENT)
            setPadding(0, 0, 0, 0)
            gravity = Gravity.CENTER_VERTICAL
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_PX, size * d)
            setTextColor(if (dark) 0xFFF2F2F4.toInt() else 0xFF1D1D1F.toInt())
            highlightColor = if (dark) 0x550A84FF else 0x552F6FEB
            isSingleLine = true
            contentDescription = "Secret"
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) { onCount(s?.length ?: 0) }
            })
            setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEND) { onSend(); true } else false }
        }
        parent.addView(e, FrameLayout.LayoutParams(1, 1))
        field = e
        move(rect)
        e.requestFocus()
        e.post { context.getSystemService(InputMethodManager::class.java).showSoftInput(e, InputMethodManager.SHOW_IMPLICIT) }
    }

    /** `rect` is x, y, width, height in CSS px from the page's top left. */
    fun move(rect: FloatArray) {
        val e = field ?: return
        val d = context.resources.displayMetrics.density
        e.layoutParams = FrameLayout.LayoutParams((rect[2] * d).toInt(), (rect[3] * d).toInt()).apply {
            leftMargin = (rect[0] * d).toInt(); topMargin = (rect[1] * d).toInt()
        }
    }

    fun reveal(on: Boolean) {
        val e = field ?: return
        val sel = e.selectionEnd
        e.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            (if (on) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD)
        e.typeface = Typeface.MONOSPACE
        e.setSelection(sel.coerceAtMost(e.length()))
    }

    /** What was typed, taken once: the field is emptied as it is read. */
    fun take(): String? {
        val e = field ?: return null
        val s = e.text.toString()
        e.text.clear()
        return s
    }

    fun close() {
        val e = field ?: return
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(e.windowToken, 0)
        e.text.clear()
        parent.removeView(e)
        field = null
        checkpoint = null
    }
}
