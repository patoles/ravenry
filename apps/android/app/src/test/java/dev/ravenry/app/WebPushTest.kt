package dev.ravenry.app

import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridDecrypt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

/**
 * The push body the hub sends (RFC 8291, aes128gcm) opens with the
 * decryption the UnifiedPush connector uses: the RFC's own example, and a
 * message encrypted with Node's crypto as the hub does.
 */
class WebPushTest {
    private val d = Base64.getUrlDecoder()

    private fun open(pub: String, priv: String, auth: String, body: String): String {
        val dec = WebPushHybridDecrypt.Builder()
            .withAuthSecret(d.decode(auth))
            .withRecipientPublicKey(d.decode(pub))
            .withRecipientPrivateKey(d.decode(priv))
            .build()
        return String(dec.decrypt(d.decode(body), null))
    }

    @Test fun theRfcExample() {
        // RFC 8291 section 5.
        val text = open(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
            "BTBZMqHH6r4Tts7J_aSIgg",
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        )
        assertEquals("When I grow up, I want to be a watermelon", text)
    }

    @Test fun aMessageEncryptedWithNode() {
        val v = JSONObject(javaClass.classLoader!!.getResource("webpush-node.json").readText())
        val text = open(v.getString("uaPublic"), v.getString("uaPrivate"), v.getString("auth"), v.getString("body"))
        assertEquals(v.getString("plaintext"), text)
        val a = Alert.parse(text)!!
        assertEquals("cp:c7k2m9qx", a.id)
        assertEquals(listOf("Ship it", "Not yet"), a.actions.map { it.label })
    }
}
