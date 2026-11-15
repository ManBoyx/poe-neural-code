#!/usr/bin/env bash
# Tests de bout en bout de l'interface Eclipse Desktop : construit l'interface, prépare Playwright (navigateur
# sans fenêtre, téléchargé une fois dans build/cache), lance tests_e2e avec le faux fournisseur (aucune IA réelle).
set -euo pipefail
cd "$(dirname "$0")/.."
echo "> Construction de l'interface"
(cd desktop && { [ -d node_modules ] || npm ci --no-fund --no-audit; } && npm run build >/dev/null)
rm -rf src/poe_neural_code/web/static && cp -r desktop/dist src/poe_neural_code/web/static
PY=${PYTHON:-.venv/bin/python}
[ -x "$PY" ] || { python3 -m venv .venv; PY=.venv/bin/python; }
"$PY" -c "import playwright, pytest" 2>/dev/null || "$PY" -m pip install -q -e ".[dev,e2e]"
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$PWD/build/cache/pw-browsers}
"$PY" -m playwright install chromium-headless-shell >/dev/null
echo "> Tests de l'interface"
"$PY" -m pytest -q tests_e2e "$@"
