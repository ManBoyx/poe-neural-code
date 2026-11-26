/**
 * Règle de l'utilisateur (26/11) : aucun modèle ni agent n'a le droit d'écrire dans les fichiers d'Eclipse
 * (son code, ses données, l'application installée), même en bypass, même dans /cg.
 * Tout travail se fait dans le dossier des projets (~/Projets, créé s'il manque) : un dossier par projet, au nom du
 * projet ; reprendre un projet, c'est revenir dans son dossier.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { dataDir, home } from "./paths"

/** Vrai dans un exécutable compilé (`bun build --compile`) : le code est alors dans un système de fichiers virtuel. */
export function compiled(): boolean {
  return import.meta.dir.includes("$bunfs") || /^[A-Za-z]:[\\/]~BUN/.test(import.meta.dir)
}

/**
 * Racine d'Eclipse : le dépôt des sources (ce fichier est dans <dépôt>/ts/src/core) ; pour un exécutable compilé,
 * l'exécutable lui-même, ou son dossier d'installation quand il est rangé dans un dossier « engine » (application desktop).
 */
export function eclipseRoot(): string {
  if (process.env.ECLIPSE_ROOT) return resolve(process.env.ECLIPSE_ROOT)
  if (compiled()) return basename(dirname(process.execPath)) === "engine" ? dirname(dirname(process.execPath)) : process.execPath
  return resolve(import.meta.dir, "..", "..", "..")
}

/** Un dossier est-il une copie des sources d'Eclipse ? (reconnu à sa structure, où qu'il soit) */
function isEclipseTree(dir: string): boolean {
  return existsSync(join(dir, "ts", "src", "core", "protect.ts")) && existsSync(join(dir, "desktop", "src-tauri"))
}

export function projectsRoot(): string {
  return process.env.ECLIPSE_PROJECTS ?? join(home(), "Projets")
}

const real = (p: string) => {
  let cur = resolve(p)
  const tail: string[] = []
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(cur.slice(dirname(cur).length + 1))
    cur = dirname(cur)
  }
  try {
    return join(realpathSync(cur), ...tail)
  } catch {
    return resolve(p)
  }
}

export function protectedRoots(): string[] {
  return [eclipseRoot(), dataDir(), join(home(), ".local/share/eclipse")].map(real)
}

const inside = (p: string, root: string) => {
  const r = relative(root, p)
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"))
}

/** Vrai si écrire à cet endroit toucherait les fichiers d'Eclipse. */
export function isProtected(p: string): boolean {
  const rp = real(p)
  if (protectedRoots().some((r) => inside(rp, r))) return true
  // les sources d'Eclipse restent protégées même quand l'exécutable compilé ne sait pas où elles sont
  for (let d = rp; ; d = dirname(d)) {
    if (isEclipseTree(d)) return true
    if (dirname(d) === d) return false
  }
}

/** Le dossier de travail convient-il à un travail qui écrit ? Sinon il faut choisir ou créer un projet. */
export function needsProject(cwd: string): boolean {
  const c = real(cwd)
  return isProtected(c) || c === real(home()) || c === real(projectsRoot()) || c === "/"
}

/** Nom de dossier propre tiré d'un texte (« Faites un snake à deux » -> « snake-a-deux »). */
export function slug(text: string): string {
  const stop = new Set(["fais", "faites", "fait", "moi", "nous", "un", "une", "le", "la", "les", "des", "du", "de", "pour", "avec", "cree", "creer", "crée", "créer", "peux", "tu", "stp", "svp"])
  const words = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? []
  const kept = words.filter((w) => !stop.has(w)).slice(0, 4)
  return (kept.length ? kept : words.slice(0, 3)).join("-").slice(0, 40) || "projet"
}

export function listProjects(): { name: string; path: string; mtime: number }[] {
  const root = projectsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && !isProtected(join(root, e.name)))
    .map((e) => ({ name: e.name, path: join(root, e.name), mtime: statSync(join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

/** Crée (si besoin) et renvoie le dossier du projet `name` dans ~/Projets. */
export function openProject(name: string): string {
  const clean = name.trim().replace(/[/\\]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "projet"
  const p = join(projectsRoot(), clean)
  if (isProtected(p)) throw new Error(`« ${clean} » est un dossier d'Eclipse : choisissez un autre nom`)
  mkdirSync(p, { recursive: true })
  return p
}

export const PROTECT_RULE =
  "Règle absolue : tu n'écris jamais dans les fichiers d'Eclipse (son code, ses réglages, ses données). " +
  "Tu travailles uniquement dans le dossier du projet en cours ; un nouveau projet a son propre dossier dans le dossier des projets."
