import { render } from "preact";
import "highlight.js/styles/github-dark.css";
import { logError } from "./api";
import { App } from "./app";
import "./styles.css";

// L'interface s'affiche tout de suite ; c'est elle qui attend le moteur (écran de démarrage, échec, panne).
render(<App />, document.getElementById("app")!);
(window as any).__eclipseReady = true; // boot.js ne sert plus qu'aux erreurs de chargement du script

addEventListener("error", (e) => logError(`window.error: ${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => logError(`promesse rejetée: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));
