package io.github.manboyx.eclipse.ssh

import io.github.manboyx.eclipse.data.Host
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.InputStream
import java.io.OutputStream
import java.security.KeyPair
import java.security.PublicKey
import java.util.concurrent.LinkedBlockingQueue

sealed class Credentials {
    class AppKey(val keyPair: KeyPair) : Credentials()
    class ImportedKey(val privateKeyText: String, val passphrase: CharArray?) : Credentials()
    class Password(val password: CharArray) : Credentials()
}

/** Décision sur la clé du serveur : null = première connexion (à confirmer), sinon l'empreinte attendue. */
fun interface HostKeyPrompt {
    /** Appelée hors du fil d'interface ; retourne true si l'utilisateur fait confiance à cette empreinte. */
    fun confirmNewHost(fingerprint: String): Boolean
}

class HostKeyMismatch(val expected: String, val actual: String) :
    Exception("La clé du serveur a changé (attendue $expected, reçue $actual). Connexion refusée.")

/**
 * Vérification de la clé du serveur, comme OpenSSH :
 * - première connexion : l'empreinte est montrée et doit être acceptée (« confiance au premier usage ») ;
 * - ensuite : elle doit être identique, sinon refus (risque d'interception).
 */
class TofuVerifier(private val expected: String?, private val prompt: HostKeyPrompt) : HostKeyVerifier {
    var accepted: String? = null
        private set
    var mismatch: HostKeyMismatch? = null
        private set

    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val fp = SshKeys.fingerprint(key)
        if (expected != null) {
            if (fp == expected) { accepted = fp; return true }
            mismatch = HostKeyMismatch(expected, fp)
            return false
        }
        return prompt.confirmNewHost(fp).also { if (it) accepted = fp }
    }

    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/** Une session interactive (shell avec terminal xterm-256color) sur un serveur. */
class SshConnection(private val host: Host, private val credentials: Credentials, prompt: HostKeyPrompt) : AutoCloseable {
    val verifier = TofuVerifier(host.hostKey, prompt)
    private val client = SSHClient(DefaultConfig())
    private var session: Session? = null
    private var shell: Session.Shell? = null

    // Un seul fil écrit sur le canal SSH, dans l'ordre d'arrivée : des écritures concurrentes mélangeraient les
    // paquets (« Bad packet length » côté serveur) et pourraient inverser des touches.
    private val lock = Any()
    private val outgoing = LinkedBlockingQueue<ByteArray>()
    private var writer: Thread? = null
    private val stop = ByteArray(0)

    val input: InputStream get() = shell!!.inputStream
    val output: OutputStream get() = shell!!.outputStream

    fun connect(cols: Int, rows: Int, timeoutMs: Int = 15_000) {
        client.addHostKeyVerifier(verifier)
        client.connectTimeout = timeoutMs
        client.timeout = 0
        try {
            client.connect(host.address, host.port)
        } catch (e: Exception) {
            throw verifier.mismatch ?: e
        }
        client.connection.keepAlive.keepAliveInterval = 30
        when (val c = credentials) {
            is Credentials.AppKey -> client.authPublickey(host.user, KeyPairWrapper(c.keyPair))
            is Credentials.ImportedKey -> {
                val finder = c.passphrase?.let { PasswordUtils.createOneOff(it) }
                client.authPublickey(host.user, client.loadKeys(c.privateKeyText, null, finder))
            }
            is Credentials.Password -> client.authPassword(host.user, c.password)
        }
        val s = client.startSession()
        s.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap())
        session = s
        val sh = s.startShell()
        shell = sh
        writer = Thread({
            try {
                while (true) {
                    var chunk = outgoing.take()
                    if (chunk === stop) break
                    synchronized(lock) {
                        while (true) {
                            sh.outputStream.write(chunk)
                            chunk = outgoing.poll() ?: break
                            if (chunk === stop) { sh.outputStream.flush(); return@Thread }
                        }
                        sh.outputStream.flush()
                    }
                }
            } catch (_: Exception) {
                // connexion fermée : la boucle de lecture signale la fin de session
            }
        }, "ssh-writer").apply { isDaemon = true; start() }
    }

    fun resize(cols: Int, rows: Int) {
        synchronized(lock) { runCatching { shell?.changeWindowDimensions(cols, rows, 0, 0) } }
    }

    /** Non bloquant, utilisable depuis le fil d'interface : les octets partent dans l'ordre d'appel. */
    fun send(bytes: ByteArray) {
        if (bytes.isNotEmpty()) outgoing.offer(bytes.copyOf())
    }

    val isConnected: Boolean get() = client.isConnected && client.isAuthenticated

    override fun close() {
        outgoing.offer(stop)
        runCatching { shell?.close() }
        runCatching { session?.close() }
        runCatching { client.disconnect() }
    }
}
