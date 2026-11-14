package io.github.manboyx.eclipse.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.res.ResourcesCompat
import io.github.manboyx.eclipse.R
import io.github.manboyx.eclipse.data.AuthMethod
import io.github.manboyx.eclipse.data.Host
import io.github.manboyx.eclipse.ssh.Credentials
import io.github.manboyx.eclipse.ssh.HostKeyMismatch
import io.github.manboyx.eclipse.ssh.SshConnection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import net.schmizz.sshj.userauth.UserAuthException
import org.connectbot.terminal.Terminal
import org.connectbot.terminal.TerminalEmulatorFactory

/** Touches absentes des claviers de téléphone, utiles pour Eclipse (Échap, Tab, Ctrl+X leader, Ctrl+T effort…). */
private val EXTRA_KEYS: List<Pair<String, ByteArray>> = listOf(
    "Échap" to byteArrayOf(0x1b), "Tab" to byteArrayOf(0x09), "Ctrl+C" to byteArrayOf(0x03), "Ctrl+X" to byteArrayOf(0x18),
    "Ctrl+T" to byteArrayOf(0x14), "Ctrl+P" to byteArrayOf(0x10), "Ctrl+D" to byteArrayOf(0x04), "/" to "/".toByteArray(),
    "|" to "|".toByteArray(), "~" to "~".toByteArray(), "-" to "-".toByteArray(),
)
private val ARROWS: List<Pair<ImageVector, ByteArray>> = listOf(
    Icons.Filled.KeyboardArrowLeft to "\u001b[D".toByteArray(), Icons.Filled.KeyboardArrowUp to "\u001b[A".toByteArray(),
    Icons.Filled.KeyboardArrowDown to "\u001b[B".toByteArray(), Icons.Filled.KeyboardArrowRight to "\u001b[C".toByteArray(),
)

@Composable
fun TerminalScreen(services: AppServices, host: Host, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("Connexion à ${host.label}…") }
    var failed by remember { mutableStateOf(false) }
    var hostKeyAsk by remember { mutableStateOf<Pair<String, CompletableDeferred<Boolean>>?>(null) }
    var passwordAsk by remember { mutableStateOf<CompletableDeferred<CharArray?>?>(null) }
    val conn = remember { arrayOfNulls<SshConnection>(1) }

    val emulator = remember {
        TerminalEmulatorFactory.create(
            initialRows = 24, initialCols = 80, defaultForeground = TextMain, defaultBackground = Bg,
            onKeyboardInput = { bytes -> conn[0]?.send(bytes) },
            onResize = { d -> conn[0]?.let { c -> scope.launch(Dispatchers.IO) { c.resize(d.columns, d.rows) } } },
        )
    }
    fun send(bytes: ByteArray) { conn[0]?.send(bytes) }

    DisposableEffect(Unit) {
        onDispose {
            conn[0]?.let { c -> Thread { c.close() }.start() }
            emulator.close()
        }
    }

    LaunchedEffect(host.id) {
        withContext(Dispatchers.IO) {
            try {
                val creds: Credentials = when (host.auth) {
                    AuthMethod.APP_KEY -> Credentials.AppKey(services.appKey() ?: error("Aucune clé : générez la clé de l'application dans Réglages."))
                    AuthMethod.IMPORTED_KEY -> Credentials.ImportedKey(
                        String(services.secrets.get("host:${host.id}:key") ?: error("Aucune clé importée pour ce serveur.")),
                        services.secrets.get("host:${host.id}:passphrase")?.let { String(it).toCharArray() },
                    )
                    AuthMethod.PASSWORD -> Credentials.Password(
                        services.secrets.get("host:${host.id}:password")?.let { String(it).toCharArray() }
                            ?: CompletableDeferred<CharArray?>().also { passwordAsk = it }.await()
                            ?: error("Connexion annulée."),
                    )
                }
                val c = SshConnection(host, creds) { fp ->
                    val d = CompletableDeferred<Boolean>()
                    hostKeyAsk = fp to d
                    runBlocking { d.await() }
                }
                conn[0] = c
                val dims = emulator.dimensions
                c.connect(dims.columns, dims.rows)
                c.verifier.accepted?.let { fp -> if (host.hostKey == null) services.hosts.save(host.copy(hostKey = fp)) }
                emulator.dimensions.let { c.resize(it.columns, it.rows) }
                status = ""
                if (host.startup.isNotBlank()) c.send((host.startup + "\r").toByteArray())
                val buf = ByteArray(16 * 1024)
                val input = c.input
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    emulator.writeInput(buf, 0, n)
                }
                status = "Session terminée."
            } catch (e: HostKeyMismatch) {
                failed = true
                status = "ATTENTION : la clé de ce serveur a changé. Connexion refusée (risque d'interception).\n" +
                    "Attendue : ${e.expected}\nReçue : ${e.actual}\nSi le changement est normal (serveur réinstallé), oubliez l'empreinte dans la fiche du serveur."
            } catch (e: UserAuthException) {
                failed = true
                status = "Authentification refusée par le serveur (${host.auth.label()})."
            } catch (e: Exception) {
                failed = true
                status = "Connexion impossible : ${e.message ?: e.javaClass.simpleName}"
            }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().background(Chrome).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(host.name, color = Accent, fontWeight = FontWeight.Bold)
                Text(host.label, color = Muted, fontFamily = Mono, fontSize = 11.sp)
            }
            IconButton(onClick = onClose) { Icon(Icons.Filled.Close, "Fermer la session") }
        }
        Box(Modifier.weight(1f).fillMaxWidth().background(Bg)) {
            Terminal(
                terminalEmulator = emulator,
                modifier = Modifier.fillMaxSize(),
                typeface = ResourcesCompat.getFont(ctx, R.font.jetbrains_mono_nf) ?: android.graphics.Typeface.MONOSPACE,
                backgroundColor = Bg,
                foregroundColor = TextMain,
                keyboardEnabled = true,
                showSoftKeyboard = true,
                onHyperlinkClick = { url -> if (url.startsWith("https://") || url.startsWith("http://")) ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
            )
            if (status.isNotEmpty()) {
                Text(
                    status, color = if (failed) Err else Muted, fontFamily = Mono, fontSize = 13.sp,
                    modifier = Modifier.align(Alignment.Center).padding(16.dp).background(Chrome, RoundedCornerShape(8.dp)).padding(14.dp),
                )
            }
        }
        Row(
            Modifier.fillMaxWidth().background(Chrome).horizontalScroll(rememberScrollState()).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            EXTRA_KEYS.forEach { (label, bytes) ->
                TextButton(onClick = { send(bytes) }) { Text(label, fontFamily = Mono, fontSize = 13.sp, color = TextMain) }
            }
            ARROWS.forEach { (icon, bytes) -> IconButton(onClick = { send(bytes) }) { Icon(icon, null) } }
        }
    }

    hostKeyAsk?.let { (fp, d) ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Première connexion à ${host.address}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Vérifiez que cette empreinte est bien celle du serveur (sur le serveur : ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) :")
                    Text(fp, fontFamily = Mono, fontSize = 12.sp)
                    Text("Elle sera mémorisée et vérifiée à chaque connexion.", color = Muted, fontSize = 12.sp)
                }
            },
            confirmButton = { TextButton(onClick = { hostKeyAsk = null; d.complete(true) }) { Text("Faire confiance") } },
            dismissButton = { TextButton(onClick = { hostKeyAsk = null; d.complete(false) }) { Text("Annuler") } },
        )
    }
    passwordAsk?.let { d ->
        var pw by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Mot de passe pour ${host.label}") },
            text = { OutlinedTextField(pw, { pw = it }, singleLine = true, visualTransformation = PasswordVisualTransformation()) },
            confirmButton = { TextButton(onClick = { passwordAsk = null; d.complete(pw.toCharArray()) }) { Text("Se connecter") } },
            dismissButton = { TextButton(onClick = { passwordAsk = null; d.complete(null) }) { Text("Annuler") } },
        )
    }
}

private fun AuthMethod.label() = when (this) {
    AuthMethod.APP_KEY -> "clé de l'application : ajoutez sa clé publique dans ~/.ssh/authorized_keys"
    AuthMethod.IMPORTED_KEY -> "clé importée"
    AuthMethod.PASSWORD -> "mot de passe"
}
