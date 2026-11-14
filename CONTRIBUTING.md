# Contribuer

Eclipse est un logiciel propriétaire. Les contributions extérieures se font **sur invitation** : ouvrez d'abord une
discussion. Une contribution acceptée implique la cession des droits sur le code fourni au titulaire (voir LICENSE).

## Structure
| Dossier | Contenu |
|---|---|
| `src/poe_neural_code/` | moteur Eclipse (Python 3.11+, Textual) |
| `desktop/` | application desktop (Tauri 2 : Rust dans `src-tauri/`, interface TypeScript + xterm.js dans `src/`) |
| `android/` | application Android (Kotlin) |
| `packaging/` | PyInstaller, conteneur de construction Linux, script portable Windows, manifeste de release, install.sh |
| `.github/workflows/` | CI (tests Linux + Windows) et publication sur tag |

## Travailler en local
```sh
python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
pytest -q                                   # moteur
packaging/linux/build-local.sh              # AppImage, deb, rpm dans un conteneur (podman ou docker)
cd desktop && npm ci && npx tsc --noEmit    # interface
```

## Règles
- **Aucun emoji** dans le code ou l'interface : les icônes sont des glyphes Nerd Fonts (`ui/icons.py`, `desktop/src/main.ts`).
- **Différences Linux / Windows** : uniquement dans `platform_compat.py` (moteur), `shells.rs` et `pty.rs` (desktop).
- **Secrets** : aucun secret dans le dépôt, les tests ou les journaux.
- **Tests** : chaque modification est accompagnée de ses tests. La CI doit passer sous Linux ET Windows.

## Publier une version
1. Mettre le même numéro dans `pyproject.toml`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json` et `android/gradle.properties` (la CI le vérifie).
2. Ajouter la section `## X.Y.Z — date` dans `CHANGELOG.md` : c'est le journal affiché par l'application.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` pour une version stable, ou `vX.Y.Z-beta.N` pour une bêta.
   La CI vérifie tout, construit, signe et publie.
