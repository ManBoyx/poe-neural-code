package io.github.manboyx.eclipse.update

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Mises à jour hors Play Store : lit la dernière version publiée sur le dépôt public de distribution et
 * propose de télécharger l'APK. Android n'installe une mise à jour que si elle est signée avec la MÊME clé que
 * l'application installée : c'est la garantie d'authenticité. L'empreinte SHA-256 (fichier SHA256SUMS) est affichée.
 * Aucune donnée n'est envoyée en dehors de la requête elle-même (adresse IP visible par GitHub).
 */
object Updates {
    const val REPO = "ManBoyx/eclipse-releases"
    const val APK = "Eclipse.apk"

    data class Info(val version: String, val notes: String, val apkUrl: String, val sha256: String?, val page: String)

    /** Compare deux versions X.Y.Z[-pre.N] ; une préversion est inférieure à la version finale. */
    fun compare(a: String, b: String): Int {
        fun parts(v: String): Pair<List<Int>, List<String>> {
            val clean = v.trim().removePrefix("v")
            val core = clean.substringBefore("-")
            val pre = clean.substringAfter("-", "")
            return core.split(".").map { it.toIntOrNull() ?: 0 } to (if (pre.isEmpty()) emptyList() else pre.split("."))
        }
        val (ca, pa) = parts(a)
        val (cb, pb) = parts(b)
        for (i in 0 until maxOf(ca.size, cb.size)) {
            val d = ca.getOrElse(i) { 0 }.compareTo(cb.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        if (pa.isEmpty() && pb.isEmpty()) return 0
        if (pa.isEmpty()) return 1
        if (pb.isEmpty()) return -1
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrNull(i) ?: return -1
            val y = pb.getOrNull(i) ?: return 1
            val d = if (x.toIntOrNull() != null && y.toIntOrNull() != null) x.toInt().compareTo(y.toInt()) else x.compareTo(y)
            if (d != 0) return d
        }
        return 0
    }

    fun shaFor(sums: String, file: String): String? = sums.lineSequence()
        .map { it.trim().split(Regex("\\s+"), limit = 2) }
        .firstOrNull { it.size == 2 && it[1].removePrefix("*") == file && it[0].length == 64 }
        ?.get(0)?.lowercase()

    /** Choisit la release : stable = dernière non-préversion ; bêta = la plus récente, préversions comprises. */
    fun pickRelease(releases: JSONArray, beta: Boolean): JSONObject? =
        (0 until releases.length()).map { releases.getJSONObject(it) }
            .filter { !it.optBoolean("draft") && it.optString("tag_name").startsWith("v") }
            .filter { beta || !it.optBoolean("prerelease") }
            .maxWithOrNull { x, y -> compare(x.getString("tag_name"), y.getString("tag_name")) }

    private fun get(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 20_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Eclipse-Android")
        try {
            if (c.responseCode !in 200..299) throw IllegalStateException("GitHub a répondu ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /** Réseau : à appeler hors du fil d'interface. Retourne null si l'application est à jour. */
    fun check(current: String, beta: Boolean): Info? {
        val rel = pickRelease(JSONArray(get("https://api.github.com/repos/$REPO/releases?per_page=20")), beta) ?: return null
        val version = rel.getString("tag_name").removePrefix("v")
        if (compare(version, current) <= 0) return null
        val assets = rel.getJSONArray("assets")
        val urls = (0 until assets.length()).map { assets.getJSONObject(it) }
            .associate { it.getString("name") to it.getString("browser_download_url") }
        val apk = urls[APK] ?: urls.entries.firstOrNull { it.key.endsWith(".apk") }?.value ?: return null
        val sha = urls["SHA256SUMS"]?.let { runCatching { shaFor(get(it), APK) }.getOrNull() }
        return Info(version, rel.optString("body"), apk, sha, rel.optString("html_url"))
    }
}
