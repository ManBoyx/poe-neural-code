#!/bin/sh
# Installe Eclipse sous Linux depuis https://github.com/ManBoyx/eclipse-releases
#   curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
#   ... | sh -s -- deb      (ou rpm ; défaut : appimage, sans droits administrateur)
# Étapes : télécharge le paquet et SHA256SUMS -> vérifie la signature de SHA256SUMS (si minisign est installé)
# -> vérifie l'empreinte SHA-256 du paquet -> installe. Rien n'est exécuté avant ces vérifications.
set -eu

REPO="ManBoyx/eclipse-releases"
PUBKEY=""   # clé publique minisign des versions, insérée par la CI à la publication (vide = signature non vérifiable)
FORMAT="${1:-appimage}"
BASE="${ECLIPSE_BASE_URL:-https://github.com/$REPO/releases/latest/download}"  # surcharge réservée aux tests
say() { printf '\033[1;35m>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "ce script est pour Linux ; Windows : voir le README."
[ "$(uname -m)" = x86_64 ] || die "seule l'architecture x86_64 est publiée."
case "$FORMAT" in
  appimage) FILE="Eclipse_amd64.AppImage" ;;
  deb)      FILE="Eclipse_amd64.deb" ;;
  rpm)      FILE="Eclipse_x86_64.rpm" ;;
  *) die "format inconnu : $FORMAT (appimage, deb ou rpm)" ;;
esac
command -v curl >/dev/null || die "curl est requis."
command -v sha256sum >/dev/null || die "sha256sum est requis (coreutils)."

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
say "Téléchargement de $FILE et de SHA256SUMS"
curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
curl -fsSL -o "$TMP/SHA256SUMS.minisig" "$BASE/SHA256SUMS.minisig" || true

if [ -n "$PUBKEY" ] && command -v minisign >/dev/null; then
  say "Vérification de la signature de SHA256SUMS (minisign)"
  minisign -Vqm "$TMP/SHA256SUMS" -x "$TMP/SHA256SUMS.minisig" -P "$PUBKEY" || die "signature invalide : installation annulée."
else
  say "Signature non vérifiée (minisign absent) : seule l'empreinte SHA-256 est contrôlée."
fi

say "Vérification de l'empreinte SHA-256"
(cd "$TMP" && grep "  $FILE\$" SHA256SUMS | sha256sum -c --quiet -) || die "empreinte SHA-256 différente : installation annulée."

case "$FORMAT" in
  appimage)
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$TMP/$FILE" "$HOME/.local/bin/eclipse-terminal"
    say "Installé : $HOME/.local/bin/eclipse-terminal (mises à jour automatiques depuis l'application)" ;;
  deb)
    say "Installation avec apt (mot de passe administrateur demandé) : sudo apt install ./$FILE"
    sudo apt install -y "$TMP/$FILE" ;;
  rpm)
    say "Installation avec dnf (mot de passe administrateur demandé) : sudo dnf install ./$FILE"
    sudo dnf install -y "$TMP/$FILE" ;;
esac
say "Terminé. Lancez : eclipse-terminal"
