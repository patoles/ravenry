package dev.ravenry.app

/**
 * The Mac as a person names it, never its host name: "owners-macbook-pro-1"
 * reads "MacBook Pro". macOS makes the host name from the computer's name
 * (lower case, hyphens, a number when taken), so the model is found in it;
 * any other name (one set with RAVENRY_HUB_NAME, a machine called "studio")
 * is kept as it is. The hub says it the same way (hub/server/phone.mjs
 * sayMac); this one also covers a pairing made before it did.
 */
object MacName {
    private val MODELS = listOf(
        "macbook-pro" to "MacBook Pro", "macbook-air" to "MacBook Air", "macbook" to "MacBook",
        "imac-pro" to "iMac Pro", "imac" to "iMac", "mac-mini" to "Mac mini", "mac-studio" to "Mac Studio", "mac-pro" to "Mac Pro",
    )

    fun say(name: String?): String {
        val n = name?.trim().orEmpty()
        if (n.isEmpty()) return "your Mac"
        // A name with a space or a capital was written by a person: theirs.
        if (n.any { it == ' ' || it.isUpperCase() } && !n.contains('-')) return n
        val h = n.substringBefore('.').lowercase().replace(Regex("-\\d+$"), "")
        for ((k, v) in MODELS) if (Regex("(^|-)$k(-|$)").containsMatchIn(h)) return v
        return n.substringBefore('.')
    }
}
