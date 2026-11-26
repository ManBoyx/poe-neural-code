# Eclipse

Agent de programmation dans le terminal : Claude Code, Codex, OpenCode, Gemini CLI et les fournisseurs par clé
d'API (Poe, OpenRouter, OpenAI…) dans une seule interface. Claude Code et Codex peuvent travailler ensemble (`/cg`),
la mémoire de projet économise les tokens, la consommation est suivie, les serveurs MCP sont pris en charge.

Ce dépôt contient les versions publiées (exécutables, sommes de contrôle, installateur).

## Installation

### Linux (x86-64) : le CLI, version 5
En une ligne, sans droits administrateur :
```sh
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
```
Puis lancez `Eclipse` dans le dossier de votre projet. À la première ouverture, choisissez votre fournisseur
(`/provider`) ; `/help` liste toutes les commandes.

Le script est court ; lisez-le avant de l'exécuter :
[install.sh](https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh). Dans l'ordre, il :
1. télécharge l'archive et `SHA256SUMS` ;
2. contrôle l'empreinte SHA-256 de l'archive (rien n'est exécuté avant) ;
3. vérifie que le nouvel exécutable démarre sur votre ordinateur ;
4. l'installe dans `~/.local/bin/Eclipse`, en gardant la version précédente sous `~/.local/bin/Eclipse.ancien`.

Relancez la même commande pour mettre Eclipse à jour.

À la main : téléchargez `eclipse-cli_linux-x86_64.tar.gz`, vérifiez-le (`sha256sum -c --ignore-missing SHA256SUMS`),
décompressez-le et copiez `Eclipse` dans un dossier de votre PATH.

Recommandé :
- `secret-tool` (paquet `libsecret-tools` ou `libsecret`) : vos clés d'API restent dans le trousseau du système, jamais en clair ;
- `bubblewrap` : la sandbox des commandes et la protection des fichiers d'Eclipse ;
- `alsa-utils` : l'appel vocal (`/voice`).

### Windows, macOS, application desktop, Android
Pas encore publiés pour la version 5. Ils arriveront sur cette même page.

## Licence
Logiciel propriétaire, gratuit : voir [LICENSE](LICENSE). Failles de sécurité : voir [SECURITY.md](SECURITY.md).
