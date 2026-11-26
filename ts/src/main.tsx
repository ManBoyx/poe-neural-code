/** Point d'entrée : `Eclipse [DOSSIER]` (version TypeScript) dans le dossier courant ou celui donné. */
import { VERSION, VERSION_INFO } from "./core/version"

const arg = process.argv[2]
if (arg === "--version" || arg === "-v") {
  console.log(`Eclipse ${VERSION} (${VERSION_INFO()})`)
  process.exit(0)
}
if (arg === "--help" || arg === "-h") {
  console.log(`Eclipse ${VERSION} : agent de programmation dans le terminal.

usage : Eclipse [DOSSIER]     ouvre Eclipse dans DOSSIER (par défaut : le dossier courant)
        Eclipse --version     affiche la version
Dans Eclipse : /help liste les commandes, /provider choisit le fournisseur, /cg fait travailler Claude Code et Codex ensemble.`)
  process.exit(0)
}

const { render } = await import("@opentui/solid")
const { App } = await import("./ui/App")
await render(() => <App cwd={arg ?? process.cwd()} />, { exitOnCtrlC: false, useMouse: true })
