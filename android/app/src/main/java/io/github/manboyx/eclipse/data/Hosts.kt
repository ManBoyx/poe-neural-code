package io.github.manboyx.eclipse.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

enum class AuthMethod { APP_KEY, IMPORTED_KEY, PASSWORD }

/**
 * Un serveur. Aucune donnée secrète ici : les mots de passe et clés importées sont dans SecretStore,
 * sous le nom « host:<id>:password » / « host:<id>:key » / « host:<id>:passphrase ».
 */
data class Host(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val address: String,
    val port: Int = 22,
    val user: String,
    val auth: AuthMethod = AuthMethod.APP_KEY,
    /** Commande lancée à l'ouverture, par exemple « ECLIPSE_ICONS=nerd eclipse » pour ouvrir Eclipse sur le serveur. */
    val startup: String = "",
    /** Empreinte de la clé du serveur acceptée à la première connexion (vérifiée ensuite à chaque connexion). */
    val hostKey: String? = null,
) {
    val label: String get() = "$user@$address" + if (port != 22) ":$port" else ""

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("address", address).put("port", port).put("user", user)
        .put("auth", auth.name).put("startup", startup).put("hostKey", hostKey ?: JSONObject.NULL)

    companion object {
        fun fromJson(o: JSONObject) = Host(
            id = o.getString("id"),
            name = o.getString("name"),
            address = o.getString("address"),
            port = o.optInt("port", 22),
            user = o.getString("user"),
            auth = runCatching { AuthMethod.valueOf(o.optString("auth")) }.getOrDefault(AuthMethod.APP_KEY),
            startup = o.optString("startup", ""),
            hostKey = if (o.isNull("hostKey")) null else o.optString("hostKey").ifEmpty { null },
        )

        /** Validation simple du formulaire : message d'erreur, ou null si tout va bien. */
        fun validate(name: String, address: String, port: String, user: String): String? = when {
            name.isBlank() -> "Donnez un nom au serveur."
            address.isBlank() || address.any { it.isWhitespace() } -> "Adresse invalide."
            port.toIntOrNull()?.let { it in 1..65535 } != true -> "Port invalide (1 à 65535)."
            user.isBlank() || user.any { it.isWhitespace() } -> "Nom d'utilisateur invalide."
            else -> null
        }
    }
}

class HostStore(private val file: File) {
    @Synchronized
    fun all(): List<Host> {
        if (!file.isFile || file.length() == 0L) return emptyList()
        val arr = JSONArray(file.readText())
        return (0 until arr.length()).map { Host.fromJson(arr.getJSONObject(it)) }
    }

    @Synchronized
    fun save(host: Host) {
        val list = all().filterNot { it.id == host.id } + host
        write(list)
    }

    @Synchronized
    fun delete(id: String) = write(all().filterNot { it.id == id })

    private fun write(list: List<Host>) {
        val arr = JSONArray()
        list.sortedBy { it.name.lowercase() }.forEach { arr.put(it.toJson()) }
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(arr.toString(2))
        tmp.renameTo(file)
    }
}
