package io.github.manboyx.eclipse.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Chiffre et déchiffre des octets. L'implémentation réelle utilise une clé de l'Android Keystore. */
interface Crypter {
    fun encrypt(plain: ByteArray): ByteArray
    fun decrypt(sealed: ByteArray): ByteArray
}

/**
 * Clé AES-256-GCM générée DANS l'Android Keystore (matériel sécurisé si disponible) : elle n'est jamais exportable,
 * ni lisible par l'application, ni sauvegardée. Format : IV (12 octets) + texte chiffré + étiquette GCM.
 */
class KeystoreCrypter(private val alias: String = "eclipse-secrets") : Crypter {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    override fun encrypt(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(plain)
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        return c.doFinal(sealed, 12, sealed.size - 12)
    }
}

/**
 * Secrets (clés SSH privées, mots de passe) chiffrés un par un, dans un fichier privé de l'application.
 * Jamais en clair sur le disque, jamais journalisés, exclus des sauvegardes (voir data_extraction_rules.xml).
 */
class SecretStore(private val file: File, private val crypter: Crypter) {
    private fun load(): JSONObject =
        if (file.isFile && file.length() > 0) JSONObject(file.readText()) else JSONObject()

    private fun save(o: JSONObject) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(file)
    }

    @Synchronized
    fun put(name: String, secret: ByteArray) {
        val o = load()
        o.put(name, Base64.getEncoder().encodeToString(crypter.encrypt(secret)))
        save(o)
    }

    @Synchronized
    fun get(name: String): ByteArray? {
        val v = load().optString(name, "")
        if (v.isEmpty()) return null
        return crypter.decrypt(Base64.getDecoder().decode(v))
    }

    @Synchronized
    fun remove(name: String) {
        val o = load()
        o.remove(name)
        save(o)
    }

    fun contains(name: String): Boolean = load().has(name)
}
