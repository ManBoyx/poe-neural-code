/**
 * Clés d'API : jamais en clair sur le disque, jamais affichées ni journalisées.
 *
 * Ordre : variable d'environnement du fournisseur, puis trousseau du système.
 * Sous Linux, le trousseau est lu avec `secret-tool` (Secret Service : KWallet, GNOME Keyring) et les mêmes attributs
 * que la version Python (`service`, `username`) : une clé enregistrée par l'ancienne version est retrouvée telle quelle.
 * Une erreur du trousseau (verrouillé, refus, délai) est rapportée avec sa raison, au lieu de passer pour « pas de clé ».
 */
import { runCmd } from "./proc"

export const SERVICE = "eclipse-poe-neural-code"

export type KeyLookup =
  | { ok: true; key: string; source: string }
  | { ok: false; reason: string; missing: boolean }

type Runner = (cmd: string[], input?: string, timeoutMs?: number) => Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>

export const run: Runner = (cmd, input, timeoutMs = 20_000) => runCmd(cmd, { input, timeoutMs })

let runner: Runner = run
/** Pour les tests : remplace l'appel au trousseau. */
export function setRunner(r: Runner): void {
  runner = r
}

export function storageName(): string {
  if (process.platform === "linux") return Bun.which("secret-tool") ? "trousseau du système (Secret Service)" : "aucun trousseau : secret-tool absent"
  return "trousseau du système"
}

export async function getKey(providerId: string, envVar?: string | null): Promise<KeyLookup> {
  if (envVar && process.env[envVar]?.trim()) return { ok: true, key: process.env[envVar]!.trim(), source: `variable ${envVar}` }
  if (process.platform !== "linux") {
    return { ok: false, missing: true, reason: "trousseau de ce système pas encore pris en charge par cette version : utilisez la variable " + (envVar ?? "du fournisseur") }
  }
  if (!Bun.which("secret-tool")) {
    return { ok: false, missing: false, reason: "secret-tool est absent : impossible de lire le trousseau (paquet libsecret)" }
  }
  const r = await runner(["secret-tool", "lookup", "service", SERVICE, "username", providerId])
  if (r.timedOut) return { ok: false, missing: false, reason: "le trousseau ne répond pas (verrouillé ? une fenêtre de déverrouillage attend peut-être)" }
  const key = r.out.replace(/\r?\n$/, "")
  if (r.code === 0 && key) return { ok: true, key, source: "trousseau" }
  if (r.code === 1 && !r.err.trim()) return { ok: false, missing: true, reason: "aucune clé enregistrée" }
  return { ok: false, missing: false, reason: "erreur du trousseau : " + (r.err.trim().split("\n")[0] || `code ${r.code}`) }
}

export async function setKey(providerId: string, key: string): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "linux" || !Bun.which("secret-tool")) return { ok: false, message: "aucun trousseau utilisable : clé non enregistrée (jamais écrite en clair)" }
  const r = await runner(["secret-tool", "store", `--label=Eclipse (${providerId})`, "service", SERVICE, "username", providerId], key.trim())
  if (r.code === 0) return { ok: true, message: "clé enregistrée dans le trousseau" }
  return { ok: false, message: r.timedOut ? "le trousseau ne répond pas" : "erreur du trousseau : " + (r.err.trim().split("\n")[0] || `code ${r.code}`) }
}
