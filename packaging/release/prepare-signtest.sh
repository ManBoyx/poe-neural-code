#!/usr/bin/env bash
# Prépare un dossier de test de signature avec des clés JETABLES (jamais vos vraies clés) :
#   k1 (clé « officielle » de test), k2 (autre clé), pkg.bin signé pour la version 0.3.0 par k1, pkg-other.bin signé par k2.
# Usage : packaging/release/prepare-signtest.sh DOSSIER  puis  ECLIPSE_SIGNTEST=DOSSIER cargo test
set -euo pipefail
D=${1:?dossier}
rm -rf "$D" && mkdir -p "$D"
cd "$(dirname "$0")/../../desktop"
npx tauri signer generate --ci -p "" -w "$D/k1.key" >/dev/null 2>&1
npx tauri signer generate --ci -p "" -w "$D/k2.key" >/dev/null 2>&1
head -c 200000 /dev/urandom > "$D/pkg.bin"
cp "$D/pkg.bin" "$D/pkg-other.bin"
npx tauri signer sign -f "$D/k1.key" -p "" --app-version 0.3.0 "$D/pkg.bin" >/dev/null 2>&1
npx tauri signer sign -f "$D/k2.key" -p "" --app-version 0.3.0 "$D/pkg-other.bin" >/dev/null 2>&1
echo "clés jetables et paquets signés dans $D"
