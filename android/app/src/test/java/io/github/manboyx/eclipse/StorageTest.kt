package io.github.manboyx.eclipse

import io.github.manboyx.eclipse.data.AuthMethod
import io.github.manboyx.eclipse.data.Host
import io.github.manboyx.eclipse.data.HostStore
import io.github.manboyx.eclipse.security.Crypter
import io.github.manboyx.eclipse.security.SecretStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/** Même format que KeystoreCrypter (AES-GCM, IV en tête), avec une clé en mémoire à la place du Keystore. */
class MemoryCrypter : Crypter {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    override fun encrypt(plain: ByteArray): ByteArray {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        return iv + c.doFinal(plain)
    }
    override fun decrypt(sealed: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, 12)) }
        return c.doFinal(sealed, 12, sealed.size - 12)
    }
}

class StorageTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun secretsAreNeverWrittenInClear() {
        val f = tmp.newFile("secrets.json")
        val store = SecretStore(f, MemoryCrypter())
        store.put("host:1:password", "mot-de-passe-très-secret".toByteArray())
        assertFalse(f.readText().contains("secret"))
        assertArrayEquals("mot-de-passe-très-secret".toByteArray(), store.get("host:1:password"))
        store.remove("host:1:password")
        assertNull(store.get("host:1:password"))
    }

    @Test fun hostsRoundTripWithoutSecrets() {
        val store = HostStore(tmp.newFile("hosts.json").also { it.delete() })
        val h = Host(name = "PC", address = "100.64.0.2", port = 2222, user = "manboy", auth = AuthMethod.PASSWORD,
            startup = "ECLIPSE_ICONS=nerd eclipse", hostKey = "SHA256:abc")
        store.save(h)
        val back = store.all().single()
        assertEquals(h, back)
        store.save(back.copy(hostKey = null))
        assertNull(store.all().single().hostKey)
        store.delete(h.id)
        assertEquals(0, store.all().size)
    }

    @Test fun validation() {
        assertNull(Host.validate("PC", "pc.local", "22", "moi"))
        assertNotNull(Host.validate("", "pc", "22", "moi"))
        assertNotNull(Host.validate("PC", "pc local", "22", "moi"))
        assertNotNull(Host.validate("PC", "pc", "70000", "moi"))
        assertNotNull(Host.validate("PC", "pc", "22", ""))
    }
}
