import { render } from "preact";
import "highlight.js/styles/github-dark.css";
import { App } from "./v5/app";
import "./v5/styles.css";

// Eclipse Desktop 5 : l'interface s'affiche tout de suite et attend elle-même le moteur (écran de démarrage).
render(<App />, document.getElementById("app")!);
(window as any).__eclipseReady = true; // boot.js ne sert plus qu'aux erreurs de chargement du script
