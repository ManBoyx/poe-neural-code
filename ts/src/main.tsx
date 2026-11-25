/** Point d'entrée : `eclipse` (version TypeScript) dans le dossier courant. */
import { render } from "@opentui/solid"
import { App } from "./ui/App"

const cwd = process.argv[2] ?? process.cwd()
await render(() => <App cwd={cwd} />, { exitOnCtrlC: false, useMouse: true })
