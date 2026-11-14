package io.github.manboyx.eclipse.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.manboyx.eclipse.BuildConfig
import io.github.manboyx.eclipse.R
import io.github.manboyx.eclipse.data.AuthMethod
import io.github.manboyx.eclipse.data.Host
import io.github.manboyx.eclipse.data.HostStore
import io.github.manboyx.eclipse.security.KeystoreCrypter
import io.github.manboyx.eclipse.security.SecretStore
import io.github.manboyx.eclipse.ssh.SshKeys
import io.github.manboyx.eclipse.update.Updates
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.KeyPair

// --- Palette Eclipse (identique au desktop) ------------------------------------------------------------------
val Bg = Color(0xFF0E0E18)
val Chrome = Color(0xFF14142A)
val Line = Color(0xFF2B2B4A)
val TextMain = Color(0xFFE4E4F0)
val Muted = Color(0xFF8A8AA8)
val Accent = Color(0xFFA78BFA)
val Warn = Color(0xFFFBBF24)
val Err = Color(0xFFF87171)
val Mono = FontFamily(Font(R.font.jetbrains_mono_nf))

private val Scheme = darkColorScheme(
    primary = Accent, onPrimary = Color(0xFF12121F), background = Bg, onBackground = TextMain,
    surface = Chrome, onSurface = TextMain, surfaceVariant = Chrome, onSurfaceVariant = Muted, outline = Line, error = Err,
)

/** Dépendances de l'application (stockages), créées une fois par l'activité. */
class AppServices(context: Context) {
    val hosts = HostStore(File(context.filesDir, "hosts.json"))
    val secrets = SecretStore(File(context.filesDir, "secrets.json"), KeystoreCrypter())
    private val pubFile = File(context.filesDir, "app_key.pub.der")
    val prefs = context.getSharedPreferences("eclipse", Context.MODE_PRIVATE)

    fun appKey(): KeyPair? {
        val priv = secrets.get(APP_KEY) ?: return null
        if (!pubFile.isFile) return null
        return SshKeys.decode(priv, pubFile.readBytes())
    }

    fun generateAppKey(): KeyPair {
        val kp = SshKeys.generateEd25519()
        secrets.put(APP_KEY, kp.private.encoded)
        pubFile.writeBytes(kp.public.encoded)
        return kp
    }

    fun forgetHostSecrets(id: String) = listOf("password", "key", "passphrase").forEach { secrets.remove("host:$id:$it") }

    companion object { const val APP_KEY = "appkey:ed25519" }
}

private sealed class Screen {
    data object Hosts : Screen()
    data class Edit(val host: Host?) : Screen()
    data object Settings : Screen()
    data class Terminal(val host: Host) : Screen()
}

@Composable
fun EclipseApp(services: AppServices) {
    MaterialTheme(colorScheme = Scheme) {
        var screen by remember { mutableStateOf<Screen>(Screen.Hosts) }
        var update by remember { mutableStateOf<Updates.Info?>(null) }
        val scope = rememberCoroutineScope()
        val ctx = LocalContext.current

        fun checkUpdates(manual: Boolean) = scope.launch {
            val beta = services.prefs.getBoolean("beta", false)
            val res = withContext(Dispatchers.IO) { runCatching { Updates.check(BuildConfig.VERSION_NAME, beta) } }
            res.onSuccess { info ->
                update = info
                if (manual && info == null) toast(ctx, "Eclipse est à jour (${BuildConfig.VERSION_NAME}).")
            }.onFailure { if (manual) toast(ctx, "Vérification impossible : ${it.message}") }
        }
        LaunchedEffect(Unit) { if (services.prefs.getBoolean("autoUpdate", true)) checkUpdates(false) }

        Box(Modifier.fillMaxSize().background(Bg).safeDrawingPadding()) {
            when (val s = screen) {
                Screen.Hosts -> HostsScreen(
                    services,
                    onOpen = { screen = Screen.Terminal(it) },
                    onEdit = { screen = Screen.Edit(it) },
                    onSettings = { screen = Screen.Settings },
                )
                is Screen.Edit -> {
                    BackHandler { screen = Screen.Hosts }
                    HostEditor(services, s.host, onDone = { screen = Screen.Hosts })
                }
                Screen.Settings -> {
                    BackHandler { screen = Screen.Hosts }
                    SettingsScreen(services, onBack = { screen = Screen.Hosts }, onCheck = { checkUpdates(true) })
                }
                is Screen.Terminal -> {
                    BackHandler { screen = Screen.Hosts }
                    TerminalScreen(services, s.host, onClose = { screen = Screen.Hosts })
                }
            }
        }
        update?.let { info -> UpdateDialog(info, onDismiss = { update = null }) }
    }
}

fun toast(ctx: Context, msg: String) = android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_LONG).show()

/** Copie sans exposer : les claviers et l'aperçu Android ne montrent pas un contenu marqué sensible. */
fun copyToClipboard(ctx: Context, label: String, text: String, sensitive: Boolean = false) {
    val cm = ctx.getSystemService(ClipboardManager::class.java)
    val clip = ClipData.newPlainText(label, text)
    if (sensitive && Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    cm.setPrimaryClip(clip)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Bar(title: String, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = { Text(title, fontWeight = FontWeight.Bold) },
        navigationIcon = { if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, "Retour") } },
        actions = { actions() },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Chrome, titleContentColor = Accent),
    )
}

@Composable
private fun HostsScreen(services: AppServices, onOpen: (Host) -> Unit, onEdit: (Host?) -> Unit, onSettings: () -> Unit) {
    var hosts by remember { mutableStateOf(services.hosts.all()) }
    var confirmDelete by remember { mutableStateOf<Host?>(null) }
    Scaffold(
        containerColor = Bg,
        topBar = { Bar("Eclipse") { IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, "Réglages") } } },
        floatingActionButton = { FloatingActionButton(onClick = { onEdit(null) }, containerColor = Accent) { Icon(Icons.Filled.Add, "Ajouter un serveur") } },
    ) { pad ->
        if (hosts.isEmpty()) {
            Column(Modifier.padding(pad).padding(24.dp)) {
                Text("Aucun serveur.", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.size(8.dp))
                Text(
                    "Ajoutez un serveur avec le bouton +. Pour l'accès aux IA, ajoutez votre PC (joignable en SSH, par exemple via " +
                        "Tailscale ou WireGuard) avec la commande de démarrage « ECLIPSE_ICONS=nerd eclipse » : Eclipse s'ouvre alors " +
                        "sur le PC, avec ses agents, ses budgets et sa mémoire. Aucune clé d'IA n'est stockée sur le téléphone.",
                    color = Muted,
                )
            }
        }
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            items(hosts, key = { it.id }) { h ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(h) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(h.name, style = MaterialTheme.typography.titleMedium)
                        Text(h.label, color = Muted, fontFamily = Mono, fontSize = 13.sp)
                        if (h.startup.isNotBlank()) Text("au démarrage : ${h.startup}", color = Accent, fontFamily = Mono, fontSize = 12.sp)
                    }
                    IconButton(onClick = { onEdit(h) }) { Icon(Icons.Filled.Edit, "Modifier") }
                    IconButton(onClick = { confirmDelete = h }) { Icon(Icons.Filled.Delete, "Supprimer") }
                }
            }
        }
    }
    confirmDelete?.let { h ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Supprimer « ${h.name} » ?") },
            text = { Text("Le serveur, son empreinte et ses secrets enregistrés (mot de passe, clé importée) seront effacés du téléphone.") },
            confirmButton = {
                TextButton(onClick = {
                    services.forgetHostSecrets(h.id)
                    services.hosts.delete(h.id)
                    hosts = services.hosts.all()
                    confirmDelete = null
                }) { Text("Supprimer", color = Err) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Annuler") } },
        )
    }
}

@Composable
private fun HostEditor(services: AppServices, existing: Host?, onDone: () -> Unit) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var address by remember { mutableStateOf(existing?.address ?: "") }
    var port by remember { mutableStateOf((existing?.port ?: 22).toString()) }
    var user by remember { mutableStateOf(existing?.user ?: "") }
    var auth by remember { mutableStateOf(existing?.auth ?: AuthMethod.APP_KEY) }
    var startup by remember { mutableStateOf(existing?.startup ?: "") }
    var password by remember { mutableStateOf("") }
    var keyText by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    var hostKey by remember { mutableStateOf(existing?.hostKey) }
    var error by remember { mutableStateOf<String?>(null) }
    val id = existing?.id

    Column(Modifier.fillMaxSize()) {
        Bar(if (existing == null) "Nouveau serveur" else "Modifier", onBack = onDone)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Nom") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(address, { address = it.trim() }, label = { Text("Adresse (nom d'hôte ou IP)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(user, { user = it.trim() }, label = { Text("Utilisateur") }, singleLine = true, modifier = Modifier.weight(2f))
                OutlinedTextField(port, { port = it.filter(Char::isDigit) }, label = { Text("Port") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.weight(1f))
            }
            Text("Authentification", color = Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(auth == AuthMethod.APP_KEY, { auth = AuthMethod.APP_KEY }, label = { Text("Clé de l'app") })
                FilterChip(auth == AuthMethod.IMPORTED_KEY, { auth = AuthMethod.IMPORTED_KEY }, label = { Text("Clé importée") })
                FilterChip(auth == AuthMethod.PASSWORD, { auth = AuthMethod.PASSWORD }, label = { Text("Mot de passe") })
            }
            when (auth) {
                AuthMethod.APP_KEY -> Text("La clé publique de l'application (Réglages) doit figurer dans ~/.ssh/authorized_keys du serveur.", color = Muted, fontSize = 13.sp)
                AuthMethod.PASSWORD -> OutlinedTextField(password, { password = it },
                    label = { Text(if (id != null && services.secrets.contains("host:$id:password")) "Mot de passe (enregistré ; vide = inchangé)" else "Mot de passe (vide = demandé à chaque connexion)") },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
                AuthMethod.IMPORTED_KEY -> {
                    OutlinedTextField(keyText, { keyText = it },
                        label = { Text(if (id != null && services.secrets.contains("host:$id:key")) "Clé privée (enregistrée ; vide = inchangée)" else "Clé privée OpenSSH (-----BEGIN …)") },
                        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = Mono), modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
                    OutlinedTextField(passphrase, { passphrase = it }, label = { Text("Phrase de passe de la clé (si elle en a une)") },
                        singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                }
            }
            OutlinedTextField(startup, { startup = it }, label = { Text("Commande au démarrage (facultatif)") }, singleLine = true,
                placeholder = { Text("ECLIPSE_ICONS=nerd eclipse") }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono),
                modifier = Modifier.fillMaxWidth())
            if (hostKey != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Empreinte du serveur acceptée", color = Muted, fontSize = 13.sp)
                        Text(hostKey!!, fontFamily = Mono, fontSize = 12.sp)
                    }
                    TextButton(onClick = { hostKey = null }) { Text("Oublier") }
                }
            }
            Text("Les mots de passe et clés sont chiffrés avec une clé de l'Android Keystore ; ils ne sont jamais sauvegardés ni affichés.", color = Muted, fontSize = 12.sp)
            error?.let { Text(it, color = Err) }
            Button(onClick = {
                error = Host.validate(name, address, port, user)
                if (error != null) return@Button
                val h = Host(id = id ?: java.util.UUID.randomUUID().toString(), name = name.trim(), address = address, port = port.toInt(),
                    user = user, auth = auth, startup = startup.trim(), hostKey = hostKey)
                if (auth == AuthMethod.PASSWORD && password.isNotEmpty()) services.secrets.put("host:${h.id}:password", password.toByteArray())
                if (auth == AuthMethod.IMPORTED_KEY && keyText.isNotBlank()) {
                    services.secrets.put("host:${h.id}:key", keyText.trim().toByteArray())
                    if (passphrase.isNotEmpty()) services.secrets.put("host:${h.id}:passphrase", passphrase.toByteArray()) else services.secrets.remove("host:${h.id}:passphrase")
                }
                if (auth != AuthMethod.PASSWORD) services.secrets.remove("host:${h.id}:password")
                if (auth != AuthMethod.IMPORTED_KEY) { services.secrets.remove("host:${h.id}:key"); services.secrets.remove("host:${h.id}:passphrase") }
                services.hosts.save(h)
                onDone()
            }, modifier = Modifier.fillMaxWidth()) { Text("Enregistrer") }
        }
    }
}

@Composable
private fun SettingsScreen(services: AppServices, onBack: () -> Unit, onCheck: () -> Unit) {
    val ctx = LocalContext.current
    var key by remember { mutableStateOf(runCatching { services.appKey() }.getOrNull()) }
    var confirmRegen by remember { mutableStateOf(false) }
    var beta by remember { mutableStateOf(services.prefs.getBoolean("beta", false)) }
    var auto by remember { mutableStateOf(services.prefs.getBoolean("autoUpdate", true)) }

    Column(Modifier.fillMaxSize()) {
        Bar("Réglages", onBack = onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Section("Clé SSH de l'application") {
                if (key == null) {
                    Text("Aucune clé. Générez une clé Ed25519 : la partie privée reste chiffrée sur ce téléphone.", color = Muted)
                    Button(onClick = { key = services.generateAppKey() }) { Icon(Icons.Filled.Lock, null); Spacer(Modifier.width(8.dp)); Text("Générer la clé") }
                } else {
                    val line = SshKeys.openSshPublic(key!!.public)
                    Text("Clé publique, à ajouter dans ~/.ssh/authorized_keys :", color = Muted)
                    Text(line, fontFamily = Mono, fontSize = 12.sp, modifier = Modifier.background(Bg, RoundedCornerShape(6.dp)).padding(8.dp))
                    Text("Empreinte : ${SshKeys.fingerprint(key!!.public)}", fontFamily = Mono, fontSize = 12.sp, color = Muted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { copyToClipboard(ctx, "Clé publique Eclipse", line); toast(ctx, "Clé publique copiée") }) { Text("Copier") }
                        OutlinedButton(onClick = { confirmRegen = true }) { Icon(Icons.Filled.Refresh, null); Spacer(Modifier.width(6.dp)); Text("Remplacer") }
                    }
                }
            }
            Section("Mises à jour") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Vérifier au démarrage", Modifier.weight(1f))
                    Switch(auto, { auto = it; services.prefs.edit().putBoolean("autoUpdate", it).apply() })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Canal bêta (préversions)", Modifier.weight(1f))
                    Switch(beta, { beta = it; services.prefs.edit().putBoolean("beta", it).apply() })
                }
                OutlinedButton(onClick = onCheck) { Text("Vérifier maintenant") }
                Text("La vérification interroge github.com/${Updates.REPO} : GitHub voit votre adresse IP, rien d'autre n'est envoyé.", color = Muted, fontSize = 12.sp)
            }
            Section("Confidentialité") {
                Text("Aucune télémétrie, aucune publicité, aucun compte. Seule permission : Internet.", color = Muted)
                Text("Eclipse ${BuildConfig.VERSION_NAME}", color = Muted, fontFamily = Mono, fontSize = 12.sp)
            }
        }
    }
    if (confirmRegen) {
        AlertDialog(
            onDismissRequest = { confirmRegen = false },
            title = { Text("Remplacer la clé ?") },
            text = { Text("L'ancienne clé sera effacée : les serveurs qui l'utilisent refuseront la connexion tant que la nouvelle clé publique n'y sera pas ajoutée.") },
            confirmButton = { TextButton(onClick = { key = services.generateAppKey(); confirmRegen = false }) { Text("Remplacer", color = Err) } },
            dismissButton = { TextButton(onClick = { confirmRegen = false }) { Text("Annuler") } },
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(Chrome, RoundedCornerShape(10.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, color = Accent, fontWeight = FontWeight.Bold)
        content()
    }
}

@Composable
private fun UpdateDialog(info: Updates.Info, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Eclipse ${info.version} est disponible") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Version installée : ${BuildConfig.VERSION_NAME}", color = Muted)
                Text("Journal des changements", fontWeight = FontWeight.Bold)
                Text(info.notes.ifBlank { "Aucune note fournie." }, fontSize = 13.sp)
                info.sha256?.let { Text("SHA-256 de l'APK : $it", fontFamily = Mono, fontSize = 11.sp, color = Muted) }
                Text("Android n'installe la mise à jour que si elle est signée avec la même clé que l'application actuelle.", color = Muted, fontSize = 12.sp)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.apkUrl)))
                onDismiss()
            }) { Text("Télécharger") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Plus tard") } },
    )
}
