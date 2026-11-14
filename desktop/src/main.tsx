import { render } from "preact";
import "highlight.js/styles/github-dark.css";
import { App } from "./app";
import { connect } from "./api";
import "./styles.css";

const root = document.getElementById("app")!;
connect()
  .then(() => {
    render(<App />, root);
    (window as any).__eclipseReady = true;
  })
  .catch((e) => {
    (window as any).__eclipseReady = true;
    render(
      <div class="fatal">
        <h1>Eclipse ne peut pas joindre son moteur</h1>
        <p>{String(e?.message ?? e)}</p>
        <button class="btn primary" onClick={() => location.reload()}>Réessayer</button>
      </div>,
      root,
    );
  });
