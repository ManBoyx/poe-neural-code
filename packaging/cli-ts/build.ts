/**
 * Exécutable autonome du CLI Eclipse (TypeScript) : `bun packaging/cli-ts/build.ts [cible]`
 * cible : bun-linux-x64-baseline (défaut : tous les processeurs x86-64, même sans AVX2). Sortie : build/cli-ts/<cible>/Eclipse.
 * Le JSX Solid est compilé par le greffon d'OpenTUI, pris dans ts/node_modules (versions du fichier de verrouillage) ;
 * la bibliothèque native d'OpenTUI est embarquée. Les fichiers .env et bunfig.toml du dossier où l'on lance
 * Eclipse ne sont JAMAIS chargés (un projet ne doit pas pouvoir changer le comportement d'Eclipse).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const TARGETS = ["bun-linux-x64-baseline", "bun-linux-x64", "bun-linux-arm64"] as const
const target = process.argv[2] ?? "bun-linux-x64-baseline"
if (!(TARGETS as readonly string[]).includes(target)) {
  console.error(`cible inconnue : ${target} (possibles : ${TARGETS.join(", ")})`)
  process.exit(2)
}
const root = resolve(import.meta.dir, "..", "..")
const ts = join(root, "ts")
const pkg = await Bun.file(join(ts, "package.json")).json()
const pluginPath = Bun.resolveSync("@opentui/solid/bun-plugin", ts)
if (!pluginPath.startsWith(join(ts, "node_modules"))) {
  console.error(`greffon OpenTUI trouvé hors de ts/node_modules (${pluginPath}) : lancez « bun install » dans ts/`)
  process.exit(1)
}
const solidPlugin = (await import(pluginPath)).default

// la bibliothèque native de la cible est embarquée ; celles des autres plates-formes ne sont jamais chargées
const NATIVE = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64", "linux-x64-musl", "linux-arm64-musl"]
const mine = target.replace(/^bun-/, "").replace(/-(baseline|modern)$/, "")
const external = NATIVE.filter((n) => n !== mine).map((n) => `@opentui/core-${n}`)

const out = join(root, "build", "cli-ts", target.replace(/^bun-/, ""))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const git = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%h %cd", "--date=short"], { stdout: "pipe" }).stdout.toString().trim()

const r = await Bun.build({
  entrypoints: [join(ts, "src", "main.tsx")],
  plugins: [solidPlugin],
  external,
  minify: true,
  sourcemap: "none",
  define: { ECLIPSE_BUILD: JSON.stringify(`version ${pkg.version} · commit ${git} · ${target.replace(/^bun-/, "")}`) },
  compile: { target, outfile: join(out, "Eclipse"), autoloadDotenv: false, autoloadBunfig: false },
} as any)
if (!r.success || !existsSync(join(out, "Eclipse"))) {
  for (const l of r.logs) console.error(l)
  process.exit(1)
}
console.log(join(out, "Eclipse"))
