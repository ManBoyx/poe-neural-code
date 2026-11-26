/**
 * Exécutable autonome du CLI Eclipse (TypeScript) : `bun packaging/cli-ts/build.ts [cible]`
 * cible : bun-linux-x64-baseline (défaut : tous les processeurs x86-64, même sans AVX2). Sortie : build/cli-ts/<cible>/Eclipse.
 * Le JSX Solid est compilé par le greffon d'OpenTUI ; la bibliothèque native d'OpenTUI est embarquée dans l'exécutable.
 */
import solidPlugin from "@opentui/solid/bun-plugin"
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import pkg from "../../ts/package.json"

const target = (process.argv[2] ?? "bun-linux-x64-baseline") as Bun.Build.Target
const root = resolve(import.meta.dir, "..", "..")
const out = join(root, "build", "cli-ts", target.replace(/^bun-/, ""))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const git = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%h %cd", "--date=short"], { stdout: "pipe" }).stdout.toString().trim()

// la bibliothèque native de la cible est embarquée ; celles des autres plates-formes ne sont jamais chargées
const NATIVE = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64", "linux-x64-musl", "linux-arm64-musl"]
const mine = target.replace(/^bun-/, "").replace(/-(baseline|modern)$/, "").replace(/^windows/, "win32")
const external = NATIVE.filter((n) => n !== mine).map((n) => `@opentui/core-${n}`)

const r = await Bun.build({
  external,
  entrypoints: [join(root, "ts", "src", "main.tsx")],
  plugins: [solidPlugin],
  minify: true,
  sourcemap: "none",
  define: { ECLIPSE_BUILD: JSON.stringify(`version ${pkg.version} · commit ${git} · ${target.replace(/^bun-/, "")}`) },
  compile: { target, outfile: join(out, "Eclipse") },
} as any)
if (!r.success) {
  for (const l of r.logs) console.error(l)
  process.exit(1)
}
console.log(join(out, "Eclipse"))
