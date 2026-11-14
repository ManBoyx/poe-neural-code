package io.github.manboyx.eclipse.ssh

import net.schmizz.sshj.common.Buffer
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Clé Ed25519 de l'application : générée sur le téléphone, la partie privée ne quitte jamais le stockage chiffré. */
object SshKeys {
    fun generateEd25519(): KeyPair =
        KeyPairGenerator.getInstance("Ed25519", BouncyCastleProvider.PROVIDER_NAME).generateKeyPair()

    /** Sérialisation : PKCS#8 (privée) et X.509 (publique), à stocker chiffrées / en clair respectivement. */
    fun decode(privatePkcs8: ByteArray, publicX509: ByteArray): KeyPair {
        val kf = KeyFactory.getInstance("Ed25519", BouncyCastleProvider.PROVIDER_NAME)
        return KeyPair(kf.generatePublic(X509EncodedKeySpec(publicX509)), kf.generatePrivate(PKCS8EncodedKeySpec(privatePkcs8)))
    }

    fun publicBlob(key: PublicKey): ByteArray = Buffer.PlainBuffer().putPublicKey(key).compactData

    /** Ligne à ajouter dans ~/.ssh/authorized_keys du serveur. */
    fun openSshPublic(key: PublicKey, comment: String = "eclipse-android"): String =
        "ssh-ed25519 " + Base64.getEncoder().encodeToString(publicBlob(key)) + " " + comment

    /** Empreinte au format d'OpenSSH (ssh-keygen -lf) : SHA256:<base64 sans remplissage>. */
    fun fingerprint(key: PublicKey): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(publicBlob(key))
        return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
    }
}
