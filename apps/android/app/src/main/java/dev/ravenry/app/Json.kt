package dev.ravenry.app

import org.json.JSONObject

/**
 * An optional string field: null when it is missing, JSON null, empty or
 * the word "null". Android's org.json gives the string "null" for a JSON
 * null through optString, which once ended an alert with "null"; every
 * field that can be null is read through this instead.
 */
fun JSONObject?.str(name: String): String? {
    if (this == null || !has(name) || isNull(name)) return null
    val v = opt(name)
    val s = (v as? String) ?: v?.toString() ?: return null
    return s.takeIf { it.isNotEmpty() && it != "null" }
}

/** The same with a fallback for a missing, null or empty field. */
fun JSONObject?.str(name: String, fallback: String): String = str(name) ?: fallback
