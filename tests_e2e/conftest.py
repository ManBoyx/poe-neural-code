"""Tests de bout en bout de l'interface Eclipse Desktop (navigateur sans fenêtre, faux fournisseur).

Lancement : packaging/test-ui.sh (construit l'interface, installe Playwright si besoin, lance ces tests).
"""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "poe_neural_code" / "web" / "static" / "index.html"


@pytest.fixture
def server(tmp_path):
    if not STATIC.is_file():
        pytest.skip("interface non construite : lancer packaging/test-ui.sh")
    project = tmp_path / "projet"
    project.mkdir()
    (project / "README.md").write_text("# Démo\n", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, "-m", "tests_e2e.server", str(tmp_path / "donnees"), str(project)],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("serveur de test : " + proc.stderr.read()[-2000:])
    info = json.loads(line)
    info.update(proc=proc, project=project, data=tmp_path / "donnees", url=f"http://127.0.0.1:{info['port']}")
    yield info
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)  # serveur de test sans état à préserver
        proc.wait(5)


@pytest.fixture
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        yield b
        b.close()


@pytest.fixture
def page(browser, server):
    """Page en mode navigateur (« eclipse web ») ; les erreurs JavaScript font échouer le test."""
    pg = browser.new_page(viewport={"width": 1400, "height": 900}, color_scheme="dark")
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if "Content Security Policy" in m.text else None)
    pg.goto(f"{server['url']}/#token={server['token']}")
    pg.get_by_text("Que voulez-vous faire").wait_for(timeout=10_000)
    yield pg
    assert not errors, f"erreurs JavaScript : {errors}"


def tauri_stub(script: str) -> str:
    """Simule l'application desktop : window.__TAURI_INTERNALS__.invoke(cmd, args) -> script(cmd, args)."""
    return ("window.__TAURI_INTERNALS__ = { invoke: (cmd, args) => (" + script + ")(cmd, args), "
            "transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } };")
