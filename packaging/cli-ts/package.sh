#!/bin/sh
# Construit et empaquette le CLI Eclipse (TypeScript) pour Linux x86-64 : build/cli-ts/release/
#   eclipse-cli_linux-x86_64.tar.gz (Eclipse + LICENSE + LISEZMOI), SHA256SUMS, install.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="$HOME/.bun/bin:$PATH"
cd "$ROOT/ts"
bun install --frozen-lockfile >/dev/null
bun test >/dev/null 2>&1 || { echo "tests en échec : rien n'est empaqueté" >&2; bun test 2>&1 | tail -20; exit 1; }
cd "$ROOT"
BIN="$ROOT/build/cli-ts/linux-x64-baseline/Eclipse"
rm -f "$BIN"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
if ! bun packaging/cli-ts/build.ts bun-linux-x64-baseline >"$LOG" 2>&1; then
  grep -v '^Downloading' "$LOG" | tail -20 >&2; echo "construction en échec : rien n'est empaqueté" >&2; exit 1
fi
"$BIN" --version
# l'interface démarre-t-elle vraiment ? (--version s'arrête avant de charger OpenTUI)
PYTHON=${PYTHON:-python3}; [ -x "$ROOT/.venv/bin/python" ] && PYTHON="$ROOT/.venv/bin/python"
"$PYTHON" "$ROOT/packaging/cli-ts/smoke.py" "$BIN"
OUT="$ROOT/build/cli-ts/release"; STAGE="$ROOT/build/cli-ts/stage"
rm -rf "$OUT" "$STAGE"; mkdir -p "$OUT" "$STAGE"
cp "$BIN" "$STAGE/Eclipse"; cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cat > "$STAGE/LISEZMOI.txt" <<'TXT'
Eclipse (CLI) : agent de programmation dans le terminal.
Installation : copiez « Eclipse » dans un dossier du PATH (par exemple ~/.local/bin), puis lancez : Eclipse
Ou en une ligne : curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
Recommandé : secret-tool (trousseau, pour les clés d'API), bubblewrap (sandbox), alsa-utils (voix).
TXT
tar -C "$STAGE" -czf "$OUT/eclipse-cli_linux-x86_64.tar.gz" Eclipse LICENSE LISEZMOI.txt
cp "$ROOT/packaging/release/install.sh" "$OUT/install.sh"
(cd "$OUT" && sha256sum eclipse-cli_linux-x86_64.tar.gz install.sh > SHA256SUMS)
ls -la "$OUT"; cat "$OUT/SHA256SUMS"
