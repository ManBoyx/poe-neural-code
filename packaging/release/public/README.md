# Eclipse

Terminal de programmation avec agents IA (Claude Code, Poe, OpenCode, Codex, fournisseurs compatibles OpenAI) :
mémoire de projet, budgets locaux, MCP, et vos shells dans la même fenêtre. Linux, Windows et Android.

Ce dépôt ne contient **que les versions publiées** (binaires, sommes de contrôle, signatures). Le code source est privé.

## Installation

### Linux
**AppImage** (sans droits administrateur, mises à jour automatiques) :
```sh
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
```
**Debian, Ubuntu (.deb)** ou **Fedora, openSUSE (.rpm)** :
```sh
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh -s -- deb
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh -s -- rpm
```
Le script fait une cinquantaine de lignes. Lisez-le avant de l'exécuter :
[install.sh](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh).

Il effectue, dans l'ordre :
1. le téléchargement du paquet ;
2. la vérification de la signature de `SHA256SUMS`, si `minisign` est installé ;
3. le contrôle de l'empreinte SHA-256 du paquet ;
4. l'installation.

Rien n'est exécuté avant ces contrôles.

### Windows 10 (1809+) et 11
- **Installateur** : [Eclipse_x64-setup.exe](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/Eclipse_x64-setup.exe).
  Il s'installe sans droits administrateur et se met à jour automatiquement.
- **MSI** (déploiement en entreprise) : [Eclipse_x64.msi](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/Eclipse_x64.msi).
- **Portable** (.zip à décompresser, données dans `data\`) : [Eclipse_x64_portable.zip](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/Eclipse_x64_portable.zip).
- **Scoop** :
  ```powershell
  scoop bucket add eclipse https://github.com/ManBoyx/eclipse-releases
  scoop install eclipse/eclipse
  ```
- **winget** : `winget install ManBoyx.Eclipse` (disponible une fois le paquet accepté dans le catalogue de Microsoft).

Les binaires ne sont pas signés avec un certificat de signature de code. Windows SmartScreen affiche donc
« Windows a protégé votre ordinateur » : cliquez sur **Informations complémentaires** puis sur **Exécuter quand même**.
Vérifiez d'abord l'empreinte :
```powershell
(Get-FileHash .\Eclipse_x64-setup.exe -Algorithm SHA256).Hash   # à comparer avec SHA256SUMS
```

### Android
APK (installation hors Play Store) : [Eclipse.apk](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/Eclipse.apk).
Android demande d'autoriser l'installation depuis votre navigateur ou votre gestionnaire de fichiers.

## Vérifier un téléchargement à la main
```sh
sha256sum -c --ignore-missing SHA256SUMS
minisign -Vm SHA256SUMS -x SHA256SUMS.minisig -P <clé publique indiquée dans install.sh>
```

## Mises à jour
L'application vérifie les nouvelles versions sur ce dépôt. Avant toute installation, elle affiche le journal des
changements, puis contrôle l'empreinte SHA-256 et la signature. Canaux disponibles : **stable** et **bêta**.
La vérification automatique se désactive dans les réglages ; aucune autre donnée n'est envoyée.

## Licence
Logiciel propriétaire, gratuit : voir [LICENSE](LICENSE). Failles de sécurité : voir [SECURITY.md](SECURITY.md).
