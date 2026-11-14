package io.github.manboyx.eclipse

import io.github.manboyx.eclipse.data.AuthMethod
import io.github.manboyx.eclipse.data.Host
import io.github.manboyx.eclipse.ssh.Credentials
import io.github.manboyx.eclipse.ssh.HostKeyMismatch
import io.github.manboyx.eclipse.ssh.SshConnection
import io.github.manboyx.eclipse.ssh.SshKeys
import net.schmizz.sshj.userauth.UserAuthException
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.apache.sshd.server.shell.InteractiveProcessShellFactory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.PublicKey
import java.util.concurrent.atomic.AtomicReference

/** Vrai serveur SSH (Apache MINA) en local : clé de l'application, mot de passe, empreinte, shell interactif. */
class SshIntegrationTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: SshServer
    private val appKey = run { EclipseApplication.installBouncyCastle(); SshKeys.generateEd25519() }

    @Before fun start() {
        server = SshServer.setUpDefaultServer().apply {
            host = "127.0.0.1"
            port = 0
            keyPairProvider = SimpleGeneratorHostKeyProvider(tmp.root.toPath().resolve("hostkey.ser"))
            setPasswordAuthenticator { user, pw, _ -> user == "eclipse" && pw == "bon-mot-de-passe" }
            setPublickeyAuthenticator { user, key, _ -> user == "eclipse" && sameKey(key, appKey.public) }
            shellFactory = InteractiveProcessShellFactory.INSTANCE
            start()
        }
    }

    @After fun stop() = server.stop(true)

    private fun sameKey(a: PublicKey, b: PublicKey) = SshKeys.publicBlob(a).contentEquals(SshKeys.publicBlob(b))
    private fun host(fp: String? = null, auth: AuthMethod = AuthMethod.APP_KEY) =
        Host(name = "test", address = "127.0.0.1", port = server.port, user = "eclipse", auth = auth, hostKey = fp)

    private fun runShell(conn: SshConnection, cmd: String): String {
        conn.send("$cmd\nexit\n".toByteArray())
        return conn.input.readBytes().toString(Charsets.UTF_8)
    }

    @Test fun appKeyFirstConnectionThenPinnedFingerprint() {
        val seen = AtomicReference<String>()
        val first = SshConnection(host(), Credentials.AppKey(appKey)) { fp -> seen.set(fp); true }
        first.connect(80, 24)
        val fp = first.verifier.accepted!!
        assertEquals(seen.get(), fp)
        assertTrue(fp.startsWith("SHA256:"))
        assertTrue(runShell(first, "echo eclipse-$((40+2))").contains("eclipse-42"))
        first.close()

        // Connexion suivante : empreinte mémorisée, aucune question posée.
        val second = SshConnection(host(fp), Credentials.AppKey(appKey)) { fail("ne doit pas redemander"); false }
        second.connect(80, 24)
        second.close()
    }

    @Test fun changedHostKeyIsRefused() {
        val conn = SshConnection(host("SHA256:autre-serveur"), Credentials.AppKey(appKey)) { true }
        try {
            conn.connect(80, 24)
            fail("connexion acceptée malgré une empreinte différente")
        } catch (e: HostKeyMismatch) {
            assertEquals("SHA256:autre-serveur", e.expected)
        } finally {
            conn.close()
        }
    }

    @Test fun refusedHostKeyStopsConnection() {
        val conn = SshConnection(host(), Credentials.AppKey(appKey)) { false }
        try {
            conn.connect(80, 24)
            fail("connexion acceptée alors que l'empreinte a été refusée")
        } catch (_: Exception) {
        } finally {
            conn.close()
        }
    }

    @Test fun passwordAuthentication() {
        SshConnection(host(auth = AuthMethod.PASSWORD), Credentials.Password("bon-mot-de-passe".toCharArray())) { true }.use {
            it.connect(80, 24)
            assertTrue(runShell(it, "echo ok-mdp").contains("ok-mdp"))
        }
        SshConnection(host(auth = AuthMethod.PASSWORD), Credentials.Password("faux".toCharArray())) { true }.use {
            try {
                it.connect(80, 24)
                fail("mauvais mot de passe accepté")
            } catch (_: UserAuthException) {
            }
        }
    }

    /** Régression : des envois simultanés (clavier + boutons + redimensionnement) corrompaient les paquets SSH. */
    @Test fun concurrentSendsStayIntactAndOrderedPerSender() {
        SshConnection(host(), Credentials.AppKey(appKey)) { true }.use { conn ->
            conn.connect(80, 24)
            val threads = (1..4).map { t ->
                Thread {
                    for (k in 1..40) conn.send("echo M$t-$k\n".toByteArray())
                }
            } + Thread { repeat(40) { conn.resize(60 + it % 40, 20 + it % 10) } }
            threads.forEach { it.start() }
            threads.forEach { it.join() }
            // Une seule touche à la fois, comme un clavier : l'ordre doit être conservé.
            "echo ORDRE-OK".forEach { conn.send(byteArrayOf(it.code.toByte())) }
            conn.send("\nexit\n".toByteArray())
            val out = conn.input.readBytes().toString(Charsets.UTF_8)
            for (t in 1..4) for (k in 1..40) assertTrue("ligne M$t-$k manquante", out.contains("M$t-$k\r\n") || out.contains("M$t-$k\n"))
            assertTrue(out.contains("ORDRE-OK"))
        }
    }

    @Test fun publicKeyLineIsOpenSshFormat() {
        val line = SshKeys.openSshPublic(appKey.public)
        assertTrue(line.matches(Regex("^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/=]+ eclipse-android$")))
    }
}
