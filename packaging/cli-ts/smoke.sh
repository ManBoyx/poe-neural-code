#!/bin/sh
# Démarre l'interface de l'exécutable dans un pseudo-terminal (script), 4 s, avec des données jetables ;
# réussit si elle tourne encore au bout du délai et a dessiné son accueil. Usage : smoke.sh CHEMIN/Eclipse
set -eu
BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/projet"
set +e
(cd "$T/projet" && HOME="$T/home" PNC_HOME="$T/data" ECLIPSE_PROJECTS="$T/home/Projets" TERM=xterm-256color COLUMNS=100 LINES=30 \
  timeout 4 script -qfec "$BIN" "$T/sortie" >/dev/null 2>&1 </dev/null)
code=$?
set -e
if [ "$code" -ne 124 ]; then echo "l'interface s'est arrêtée (code $code) :" >&2; tail -c 2000 "$T/sortie" >&2; exit 1; fi
grep -q "Eclipse" "$T/sortie" || { echo "accueil non dessiné" >&2; exit 1; }
echo "interface : démarrage vérifié"
