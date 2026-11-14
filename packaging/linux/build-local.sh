#!/usr/bin/env bash
# Construit AppImage, .deb et .rpm dans un conteneur (podman ou docker), sans rien installer sur la machine.
# 1) moteur Python (PyInstaller) construit dans le conteneur ; 2) application Tauri et paquets.
set -euo pipefail
cd "$(dirname "$0")/../.."
RUNTIME=$(command -v podman || command -v docker)
"$RUNTIME" build -t eclipse-build -f packaging/linux/Containerfile packaging/linux
mkdir -p build/cache/cargo build/cache/target
"$RUNTIME" run --rm -v "$PWD":/src:Z -v "$PWD/build/cache/cargo":/opt/cargo/registry:Z \
  -e CARGO_TARGET_DIR=/src/build/cache/target -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=1 eclipse-build \
  bash -c 'set -e
    uv venv -q --python 3.12 /tmp/venv && . /tmp/venv/bin/activate
    uv pip install -q /src pyinstaller
    pyinstaller --noconfirm --log-level WARN --distpath build/engine/dist --workpath /tmp/pyi packaging/engine/eclipse-engine.spec
    cd desktop && npm ci --no-fund --no-audit && npx tauri build --bundles appimage,deb,rpm "$@"' _ "$@"
echo "Paquets : build/cache/target/release/bundle/"
