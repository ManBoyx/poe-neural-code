#!/usr/bin/env bash
# Archive autonome du CLI Eclipse (Linux) à partir du moteur PyInstaller déjà construit (build/engine/dist/eclipse-engine).
# Aucun Python requis chez l'utilisateur. Usage : packaging/cli/make-cli.sh VERSION  → build/cli/eclipse-cli_VERSION_linux-x86_64.tar.gz
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:?version attendue}"
SRC=build/engine/dist/eclipse-engine
[ -x "$SRC/eclipse-engine" ] || { echo "moteur absent : construire d'abord $SRC" >&2; exit 1; }
NAME="eclipse-cli-$VERSION"
rm -rf "build/cli/$NAME"; mkdir -p "build/cli/$NAME"
cp -a "$SRC" "build/cli/$NAME/eclipse-engine"
cat > "build/cli/$NAME/eclipse" <<'SH'
#!/bin/sh
# Lanceur du CLI Eclipse : suit les liens symboliques (ln -s .../eclipse ~/.local/bin/eclipse fonctionne).
d=$(dirname "$(readlink -f "$0")")
exec "$d/eclipse-engine/eclipse-engine" "$@"
SH
chmod +x "build/cli/$NAME/eclipse"
cat > "build/cli/$NAME/LISEZMOI.txt" <<TXT
Eclipse $VERSION : CLI (interface terminal)

Lancer :            ./eclipse            (dans un dossier de projet : cd mon-projet && /chemin/eclipse)
Installer :         ln -s "\$PWD/eclipse" ~/.local/bin/eclipse
Interface web :     ./eclipse web        (même interface que l'application desktop, dans le navigateur)
Aide :              ./eclipse --help     puis /help dans l'application
Diagnostic :        ./eclipse doctor

Les données (sessions, mémoire, réglages) sont dans ~/.local/share/poe-neural-code.
Les clés d'API sont rangées dans le trousseau du système, jamais dans un fichier.
TXT
tar -C build/cli -czf "build/cli/eclipse-cli_${VERSION}_linux-x86_64.tar.gz" "$NAME"
ls -la "build/cli/eclipse-cli_${VERSION}_linux-x86_64.tar.gz"
