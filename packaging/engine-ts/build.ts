/**
 * Moteur du desktop (Eclipse 5) en exécutable autonome : `bun packaging/engine-ts/build.ts [cible]`
 * Sortie : build/engine/dist/eclipse-engine/eclipse-engine (emplacement attendu par Tauri : resources -> engine/).
 * Comme le CLI : .env et bunfig.toml du dossier courant jamais chargés.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const TARGETS = ["bun-linux-x64-baseline", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64-baseline"] as const
const target = process.argv[2] ?? "bun-linux-x64-baseline"
if (!(TARGETS as readonly string[]).includes(target)) {
  console.error(`cible inconnue : ${target} (possibles : ${TARGETS.join(", ")})`)
  process.exit(2)
}
const root = resolve(import.meta.dir, "..", "..")
const ts = join(root, "ts")
const pkg = await Bun.file(join(ts, "package.json")).json()
const out = join(root, "build", "engine", "dist", "eclipse-engine")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const exe = join(out, target.includes("windows") ? "eclipse-engine.exe" : "eclipse-engine")
const git = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%h %cd", "--date=short"], { stdout: "pipe" }).stdout.toString().trim()
const r = await Bun.build({
  entrypoints: [join(ts, "src", "server.ts")],
  // le moteur n'affiche rien : la bibliothèque native d'OpenTUI n'a pas à être embarquée
  external: ["@opentui/core", "@opentui/solid", "@opentui/core-*"],
  minify: true,
  sourcemap: "none",
  define: { ECLIPSE_BUILD: JSON.stringify(`moteur ${pkg.version} · commit ${git} · ${target.replace(/^bun-/, "")}`) },
  compile: { target, outfile: exe, autoloadDotenv: false, autoloadBunfig: false },
} as any)
if (!r.success || !existsSync(exe)) {
  for (const l of r.logs) console.error(l)
  process.exit(1)
}
console.log(exe)
