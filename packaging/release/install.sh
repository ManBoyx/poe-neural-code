#!/bin/sh
# Installe Eclipse sous Linux depuis https://github.com/ManBoyx/eclipse-releases
#   curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
#   défaut : le CLI (Eclipse dans le terminal), dans ~/.local/bin, sans droits administrateur
#   ... | sh -s -- appimage (ou deb, rpm) : l'application desktop, quand la version en contient une
# Étapes : télécharge le paquet et SHA256SUMS -> vérifie la signature de SHA256SUMS (si minisign est installé)
# -> vérifie l'empreinte SHA-256 du paquet -> installe. Rien n'est exécuté avant ces vérifications.
set -eu

REPO="ManBoyx/eclipse-releases"
PUBKEY=""   # clé publique minisign des versions, insérée par la CI à la publication (vide = signature non vérifiable)
FORMAT="${1:-cli}"
BASE="${ECLIPSE_BASE_URL:-https://github.com/$REPO/releases/latest/download}"  # surcharge réservée aux tests
say() { printf '\033[1;35m>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "ce script est pour Linux ; Windows : voir le README."
[ "$(uname -m)" = x86_64 ] || die "seule l'architecture x86_64 est publiée."
case "$FORMAT" in
  cli)      FILE="eclipse-cli_linux-x86_64.tar.gz" ;;
  appimage) FILE="Eclipse_amd64.AppImage" ;;
  deb)      FILE="Eclipse_amd64.deb" ;;
  rpm)      FILE="Eclipse_x86_64.rpm" ;;
  *) die "format inconnu : $FORMAT (cli, appimage, deb ou rpm)" ;;
esac
command -v curl >/dev/null || die "curl est requis."
command -v sha256sum >/dev/null || die "sha256sum est requis (coreutils)."

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
say "Téléchargement de $FILE et de SHA256SUMS"
curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
curl -fsSL -o "$TMP/SHA256SUMS.minisig" "$BASE/SHA256SUMS.minisig" 2>/dev/null || true

if [ -n "$PUBKEY" ] && command -v minisign >/dev/null; then
  say "Vérification de la signature de SHA256SUMS (minisign)"
  minisign -Vqm "$TMP/SHA256SUMS" -x "$TMP/SHA256SUMS.minisig" -P "$PUBKEY" || die "signature invalide : installation annulée."
else
  say "Signature non vérifiée (minisign absent) : seule l'empreinte SHA-256 est contrôlée."
fi

say "Vérification de l'empreinte SHA-256"
(cd "$TMP" && grep "  $FILE\$" SHA256SUMS | sha256sum -c --quiet -) || die "empreinte SHA-256 différente : installation annulée."

case "$FORMAT" in
  cli)
    command -v tar >/dev/null || die "tar est requis."
    mkdir -p "$TMP/x" "$HOME/.local/bin"
    tar -xzf "$TMP/$FILE" -C "$TMP/x"
    [ -f "$TMP/x/Eclipse" ] || die "archive incomplète : installation annulée."
    chmod 755 "$TMP/x/Eclipse"
    VER=$("$TMP/x/Eclipse" --version 2>/dev/null) || die "le nouvel exécutable ne démarre pas sur cet ordinateur : rien n'a été remplacé."
    case "$VER" in "Eclipse "*) ;; *) die "exécutable inattendu dans l'archive : rien n'a été remplacé." ;; esac
    DEST="$HOME/.local/bin/Eclipse"
    if [ -d "$DEST" ] && [ ! -L "$DEST" ]; then die "$DEST est un dossier : rien n'a été remplacé."; fi
    NEW=$(mktemp "$HOME/.local/bin/.Eclipse.XXXXXX")
    install -m 755 "$TMP/x/Eclipse" "$NEW"
    if [ -e "$DEST" ]; then
      # copie du CONTENU de la version actuelle (même si Eclipse est un lien) dans un fichier neuf, puis remplacement
      # d'un bloc de Eclipse.ancien : rien n'est écrit à travers un lien, rien n'est supprimé avant que la copie existe
      BK=$(mktemp "$HOME/.local/bin/.Eclipse.ancien.XXXXXX")
      cp -L "$DEST" "$BK" && chmod 755 "$BK" && mv -fT "$BK" "$HOME/.local/bin/Eclipse.ancien" \
        || { rm -f "$NEW" "$BK"; die "sauvegarde de la version actuelle impossible : rien n'a été remplacé."; }
      say "Version précédente gardée : ~/.local/bin/Eclipse.ancien"
    fi
    mv -fT "$NEW" "$DEST" || { rm -f "$NEW"; die "remplacement impossible."; }   # d'un bloc, même si Eclipse tourne
    [ -e "$HOME/.local/bin/eclipse" ] || [ -L "$HOME/.local/bin/eclipse" ] || ln -s Eclipse "$HOME/.local/bin/eclipse"
    say "Installé : $DEST ($VER)"
    command -v secret-tool >/dev/null || say "Conseil : installez secret-tool (paquet libsecret-tools ou libsecret) pour enregistrer vos clés d'API dans le trousseau."
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Ajoutez ~/.local/bin à votre PATH pour lancer Eclipse depuis n'importe quel dossier." ;; esac
    say "Terminé. Lancez : Eclipse"
    exit 0 ;;
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
