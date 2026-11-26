# Eclipse 0.2.0 — nom de code « POE · Neural Code »

**Eclipse** est un agent de programmation en terminal (Python/Textual, Windows et Linux) : mémoire externe structurée (Neural Memory Engine),
suivi local de consommation, serveurs MCP, **skills, plugins et modes**, et deux fournisseurs : **Poe** (clé `POE_API_KEY`) ou **Claude Code** (abonnement).
Ergonomie inspirée d'OpenCode : mêmes commandes slash, même touche « leader », `@fichier`, `!commande`, modes build/plan.

## Nouveautés 0.2.0
Interface refaite (barre d'état, saisie multiligne avec historique, indicateur d'activité, pied de tour avec coût, onglets, blocs repliables, diffs toujours visibles),
**modèles gratuits** (`/free`), images jointes, `web_fetch`, paramètres d'échantillonnage, `/retry` `/edit` `/fork` `/add-dir` `/system` `/config` `/doctor` `/context` `/diff`,
commandes-prompts `/review` `/explain` `/tests` `/fix` `/commit` `/plan`. Détail : [CHANGELOG.md](CHANGELOG.md).

## Icônes
Aucun emoji : Eclipse utilise les icônes **Nerd Fonts** (jeux Material Design, Devicons, Codicons ; noms et codes vérifiés dans la liste officielle nerdfonts.com).
Elles s'affichent si une police Nerd Font est installée (par ex. JetBrainsMono Nerd Font) et utilisée ou disponible en repli par le terminal ; sinon, `/config` → `icons = text`
remplace chaque icône par un symbole texte simple.

## Modèles gratuits (`/free` ou `eclipse free`)
| Source | Ce qu'il faut | Contrôle par Eclipse | Remarques |
|---|---|---|---|
| **OpenCode** (modèles `-free`) | OpenCode installé, **aucun compte** | mode délégué : pas d'aperçu des commandes, tokens estimés | Leur API refuse l'usage hors d'OpenCode : Eclipse passe par OpenCode lui-même, sans imiter son client. |
| **OpenRouter** `:free` | compte gratuit + clé (`/connect`) | **complet** (aperçu, diffs, permissions, mémoire) | limites quotidiennes d'OpenRouter ; données envoyées à des tiers |
| **Ollama** (local) | `ollama serve` + un modèle (≈ 2 à 5 Go) | **complet** | privé, gratuit, mais lent sans carte graphique |
| Groq, Google AI Studio, Mistral, Cerebras, GitHub Models | clé gratuite chez le fournisseur | complet | quotas et conditions propres à chacun ; adresses à confirmer pour certains |

## Installation
**Eclipse 5 (CLI, Linux x86-64)** : un seul exécutable autonome, installé dans `~/.local/bin/Eclipse` :
```sh
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
```
Depuis le code source : `cd ts && bun install && bun run src/main.tsx` (Bun ≥ 1.4) ; exécutable :
`packaging/cli-ts/package.sh`. Les sections ci-dessous décrivent encore la version Python (0.x à 4.x), dont le moteur
sert toujours à l'application desktop jusqu'à la fin de sa refonte.

**Préversion privée (version Python)** : page « Releases » de ce dépôt (connecté à GitHub), version `prive-v0.3.0`.

| Fichier | Contenu |
|---|---|
| `Eclipse_0.3.0_amd64.AppImage` / `.deb` / `.rpm` | Linux : application desktop (interface graphique, moteur inclus) |
| `Eclipse_0.3.0_x64-setup.exe` / `.msi` / `_portable.zip` | Windows : application desktop (installateur, MSI, version portable) |
| `eclipse-cli_0.3.0_linux-x86_64.tar.gz` | Linux : CLI autonome (interface terminal), sans Python à installer |
| `eclipse-cli_0.3.0_windows-x64.zip` | Windows : CLI autonome (`eclipse.cmd`), sans Python à installer |
| `poe_neural_code-0.3.0-py3-none-any.whl` | CLI pour Python ≥ 3.11 : `pipx install ./poe_neural_code-0.3.0-py3-none-any.whl` |

Téléchargement en ligne de commande : `gh release download prive-v0.3.0 -R ManBoyx/poe-neural-code -p '*.AppImage'`.
Ces fichiers ne sont pas signés pour la mise à jour automatique : on installe les versions suivantes à la main.
Nouvelle préversion : Actions > « Préversion privée » > Run workflow (Linux, Windows, ou les deux).

**Utilisateurs (après la publication publique)** : applications Linux (AppImage, .deb, .rpm), Windows (installateur, MSI, portable, Scoop) et Android.
Toutes les commandes sont sur https://github.com/ManBoyx/eclipse-releases. Linux, en une ligne :
```sh
curl -fsSL https://github.com/ManBoyx/eclipse-releases/releases/latest/download/install.sh | sh
```
**Depuis le code source** (développement, moteur seul dans votre terminal) :
```bash
# Linux
python3 -m venv .venv && . .venv/bin/activate && pip install -e .
# Windows (PowerShell)
py -3.11 -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -e .
```
Python ≥ 3.11 · textual, httpx, pydantic, mcp (SDK officiel), jsonschema · tests : `pip install -e .[dev] && pytest`.

## Lancer
```bash
eclipse                  # accueil : ouvrir un dossier ou reprendre une session
eclipse ~/projet         # ouvrir directement          eclipse --resume ID
eclipse run "demande"    # non interactif (--provider claude|poe  --model M  --agent plan)
eclipse models | sessions | export ID | stats | skills | plugins | modes
```

## Interface
Barre d'état (projet, branche, fournisseur, modèle, mode, bypass, contexte, consommation), conversation en blocs (Markdown, outils repliables d'un clic, diffs colorés toujours affichés, réflexion masquable, pied de tour avec durée et coût), indicateur d'activité, saisie **multiligne** (Maj+Entrée) avec historique (↑/↓) et **aperçu des
commandes pendant la frappe** (`/` + lettres ; ↑↓ choisir, Tab compléter, Entrée exécuter), `@fichier` (recherche floue, contenu joint), `!commande`
(aperçu + confirmation). Barre latérale (Ctrl+B) à onglets : **Session** (contexte, todo, fichiers modifiés) · **Conso** · **Outils** (permissions, dossiers, extensions, MCP, fusion, skills, modes). Thèmes (`/themes`,
aperçu en direct) : `eclipse`, `eclipse-light` + thèmes Textual. **Aperçu avant exécution** : toute commande/modification passe par une fenêtre montrant
la commande complète ou le diff, avec avertissements, avant votre accord.

### Commandes slash — toutes celles d'OpenCode (doc officielle) + celles d'Eclipse
| OpenCode | Raccourci | Rôle |
|---|---|---|
| `/connect` | | connexions en 3 blocs : agents installés, clés d'API, serveurs locaux |
| `/compact` (`/summarize`) | Ctrl+X C | compacter la session (résumé vérifiable, archives conservées) |
| `/editor` | Ctrl+X E | rédiger dans `$EDITOR` |
| `/exit` (`/quit`, `/q`) | Ctrl+X Q | quitter |
| `/export` | Ctrl+X X | export Markdown, ouvert dans `$EDITOR` |
| `/help` | | aide : commandes et raccourcis |
| `/init` | | crée/met à jour `AGENTS.md` (par l'agent) |
| `/models` | Ctrl+X M | sélecteur de modèles (favoris Ctrl+F, récents F2) |
| `/new` (`/clear`) | Ctrl+X N | nouvelle session |
| `/undo` · `/redo` | Ctrl+X U / R | annule/rétablit le message **et les fichiers** (via Git, index/historique jamais touchés) |
| `/sessions` (`/resume`, `/continue`) | Ctrl+X L | changer de session |
| `/themes` | Ctrl+X T | thèmes |
| `/thinking` | | afficher/masquer la réflexion (n'active pas le raisonnement : voir Ctrl+T) |
| `/update` | | versions d'Eclipse et de Claude Code |

Propres à Eclipse : `/agents` `/mode NOM` (Tab / Maj+Tab) · `/provider ID` · `/effort rapide|normal|profond` (**Ctrl+T**, `/effort par-defaut NIVEAU`) `/options` · `/detect` · `/agent-path ID CHEMIN` · `/doctor` · `/context` · `/permissions` `/bypass` (Ctrl+X P) · `/fusion` · `/usage` (Ctrl+X I) · `/status` · `/sidebar` · `/details` ·
`/timeline` · `/copy` · `/rename` · `/skills` · `/plugins` · `/mcp` · `/memory` · `/verify` · `/todo` · `/define-token` · `/claude-limit` · `/rate` · `/spent` · `/reload`.
Autres touches : Échap interrompre · Ctrl+P palette · Ctrl+C vider/quitter · PgHaut/PgBas · F2 modèle récent.

## Réglages selon le modèle actif (effort, recherche web, réflexion…)
Effort simple, identique dans le CLI et le desktop : **rapide**, **normal**, **profond**, traduits vers les valeurs réelles du modèle (low, medium, high, ou à défaut
la plus basse, celle du milieu, la plus haute). Effort par défaut : `/effort par-defaut NIVEAU` ou Réglages du desktop. Le desktop accepte aussi les commandes `/` du CLI (F1 pour la liste).
`/options` (ou Ctrl+T pour l'effort) : la liste vient du **catalogue du fournisseur pour le modèle choisi** (ex. Poe : `reasoning_effort`, `web_search`,
`enable_thinking`, `thinking_budget`, `verbosity`… avec leurs valeurs permises et défauts) ; rien n'est supposé. Les valeurs choisies sont envoyées dans le corps de
la requête (si l'API les refuse en 400, la requête est renvoyée sans elles, avec avertissement). Claude Code : `--effort low|medium|high|xhigh|max` + `/model haiku|sonnet|opus`.

## Modes, skills, plugins, commandes personnalisées
- **Modes** (`build` complet, `plan` lecture seule appliqué **par le code**, + `.eclipse/modes/*.md`, `.opencode/agents/*.md`, `.claude/agents/*.md`) : en-tête `description`,
  `mode: primary|subagent`, `model`, `readonly`, `tools`, corps = prompt système. Tab alterne les modes primaires. Les sous-agents sont listés mais pas encore délégables.
- **Skills** : `NOM/SKILL.md` dans `.eclipse|.claude|.opencode|.agents/skills/` (projet) ou `~/.config/eclipse|~/.claude|~/.config/opencode/skills`. Catalogue (nom+description) dans le
  prompt, contenu chargé **à la demande** par l'outil `skill`. Les skills **du projet** (contenu de dépôt non fiable) demandent votre confirmation avec aperçu.
- **Plugins** Python (`.eclipse/plugins/*.py`, `~/.config/eclipse/plugins/`) : `setup(api)` avec `api.tool`, `api.command`, `api.on("tool_before"|"tool_after"|"turn_start"|"turn_done")`
  (un hook `tool_before` peut refuser un outil). **Code exécuté avec vos droits, sans sandbox** : chargé seulement après `/plugins trust NOM` (aperçu du code), approbation liée à l'empreinte
  SHA-256 du fichier (toute modification la retire). Les outils de plugin demandent confirmation.
- **Commandes personnalisées** : `.eclipse|.opencode|.claude/commands/*.md` (+ globales) avec `$ARGUMENTS`, `$1…$9`, en-tête `description`, `agent`, `model` (`fournisseur/modèle#variante`).
  Les commandes intégrées ne sont jamais écrasées. `AGENTS.md` (ou `CLAUDE.md`) du projet est ajouté au prompt comme consigne, jamais comme permission.

## Connexions en 3 blocs (`/connect` dans le CLI, Connexions dans le desktop)
1. **Agents installés sur cet ordinateur**, détectés automatiquement : installé ou non, chemin, version, source (les absents sont grisés, jamais cachés).
2. **Fournisseurs par clé d'API** : la clé va dans le trousseau du système ; les variables d'environnement restent prises en compte.
3. **Serveurs locaux compatibles** : LM Studio (`http://localhost:1234/v1`), Ollama, ou toute URL compatible OpenAI ; détectés s'ils tournent, avec leurs modèles chargés.

Détection des agents : PATH du processus, PATH de votre shell de connexion, dossiers d'installation courants (npm global, nvm, fnm, pnpm, bun, `~/.local/bin`,
`~/.opencode/bin`…) et chemin manuel. Une application lancée depuis le menu du bureau voit donc les mêmes agents que le terminal. `/detect` relance la détection,
`/agent-path ID CHEMIN` (ou `eclipse agent-path ID CHEMIN`) impose un exécutable, `/doctor` donne pour chaque agent le chemin trouvé ou la raison de l'échec.
Ajouter un agent : une ligne dans la table `PRESETS` de `cli_agents.py`, ou `<données>/agents.json`.

Tous passent par la **maîtrise des tokens d'Eclipse** (journal mesuré/estimé, limite avant et pendant le tour, alertes, pause, interruption).
- **Agents installés** : *Claude Code* (intégration complète : outils d'Eclipse, aperçu, confirmation), *OpenCode* (testé en réel, mémoire d'Eclipse par MCP), *Gemini CLI*, *Codex CLI*, *Kiro CLI*,
  *Aider*, *Goose*, *Qwen Code*, *Cursor CLI*, *GitHub Copilot CLI*, *Amp*, *Crush*, *Droid*, *Cline CLI* (préréglages non vérifiés, étiquetés) et vos propres agents via `<données>/agents.json`. **Mode délégué** pour les agents autres que Claude Code : l'agent exécute ses PROPRES
  outils (Eclipse ne peut pas en prévisualiser les commandes — annoncé), tokens mesurés si l'agent les donne sinon **estimés**, mode `plan` transmis si l'agent a une option lecture seule.
- **API par clé** : Poe, OpenRouter, OpenCode Zen et OpenCode Go (modèles au format OpenAI ; les gratuits de Zen restent réservés à OpenCode, via `/free`), OpenAI, Anthropic (API), Google Gemini, Mistral, Groq, DeepSeek, xAI, Together, Ollama et LM Studio (locaux), ou toute adresse compatible OpenAI
  (« Autre fournisseur »). Vous saisissez la clé (masquée) ; elle est vérifiée puis stockée dans le trousseau du système (Secret Service/KWallet sous Linux, Gestionnaire d'identification sous Windows) ; sans trousseau disponible, elle n'est pas enregistrée (jamais en clair) : utilisez alors la variable d'environnement du fournisseur. Les modèles
  du fournisseur apparaissent aussitôt dans `/models`. Hors Poe : pas de « points », mais USD estimé (prix du catalogue × tokens mesurés) et limites de tokens. `/disconnect ID` oublie une clé.

## Consommation : `/usage` et panneau latéral
Même ordre logique partout : **fournisseur/modèle → cette session → budget (points, tokens, temps) → abonnement Claude (fenêtres 5 h/7 j) → totaux locaux** ; une ligne par *nature* de valeur
(`[mesuré]`, `[estimé]`, `[saisi]`, `[indisponible]`, jamais additionnées). `/usage` (Ctrl+X I) ajoute les tableaux aujourd'hui / semaine / mois **par modèle ou agent**, y compris les assistants consultés en fusion.

## Permissions : `/permissions`, `/bypass`
`ask` (tout confirmer, par défaut) · `edits` (modifications de fichiers du projet acceptées d'office) · **`bypass`** (plus aucune confirmation : commandes, MCP, plugins, skills, fusion…).
Planchers : `sudo` reste **toujours refusé** ; les actions **destructrices** ou **hors du projet** redemandent confirmation, sauf **`/bypass all`** (choix explicite et distinct). L'activation demande une confirmation,
un badge rouge « ⚠ BYPASS » reste affiché, et le mode **n'est jamais conservé** au redémarrage. Pour les agents externes délégués, Eclipse transmet leur option « sans confirmation » (OpenCode `--auto`, Gemini `yolo`)
seulement en bypass et jamais en mode plan. En ligne de commande : `eclipse run --bypass …`.

## Discussion Claude Code et Codex (`/cg`)

Dans un projet ouvert, `/cg` crée une conversation Eclipse dans le même dossier. Choisissez Claude Code, Codex ou la coordination alternée. Les propositions, la répartition du travail et les rapports restent dans le fil quand vous reprenez la session. Les étapes de modification passent par les autorisations d’Eclipse.

Le mode utilise les SDK Claude Agent et Codex, les exécutables Claude Code et Codex configurés dans `/connect`, et Node.js 18 ou plus récent. Le paquet Desktop embarque les modules SDK lors de sa construction. Si les modules manquent, Eclipse les installe avec npm dans son dossier de données au premier message de `/cg`. Ce premier démarrage nécessite un accès au registre npm.

## Mode fusion : un modèle qui en consulte d'autres (`/fusion`)
Le modèle/agent **actif** peut s'aider d'autres assistants disponibles via l'outil `ask_helper` : *Claude Code qui consulte Kiro, OpenCode, Gemini CLI ou un modèle d'une API connectée*, etc. `/fusion` (sélecteur) ou
`/fusion add cli:opencode | claude | api:openrouter/MODÈLE`, `/fusion on|off|list|max N`. Chaque consultation **montre le texte envoyé et demande confirmation** (il quitte l'application vers un autre fournisseur) ;
l'assistant n'a **aucun outil** (pas de récursion) et tourne en lecture seule quand il le permet ; plafond de consultations par tour (3 par défaut) ; consommation comptée **à part** (`fusion:…`, visible dans `/usage`, limitable avec
un budget de portée `fusion:*`) ; sa réponse est une **donnée non fiable**. Aucune supériorité entre assistants n'est présumée. Les agents délégués (OpenCode…) n'ont pas de canal d'outils : ils ne peuvent pas *appeler* la fusion.

## Barres de progression
Barres colorées (vert → jaune → orange → rouge) dans la barre latérale : **consommation** (points, tokens), **temps** (avancement de la période de renouvellement, en bleu), **contexte**, et pour
Claude Code l'**usage des fenêtres 5 h / 7 j** de l'abonnement avec le temps écoulé et un indicateur de rythme (« rythme élevé » si l'usage avance plus vite que le temps).

## Fournisseurs (détail)
**Poe** : clé via `POE_API_KEY` (sans elle, aucune réponse n'est simulée). **Claude Code** (`/provider claude`) : `claude -p` via l'abonnement, outils intégrés désactivés (vérifié à l'init),
actions via un pont MCP local (127.0.0.1, jeton aléatoire) qui expose les outils d'Eclipse → aperçu, diffs, confirmation, périmètre, mémoire, todo, modes, plugins. Consommation mesurée
(tokens, équivalent API indicatif, fenêtres d'abonnement 5 h/7 j), limite propre `/claude-limit 200000 5h`.

## Mémoire, budgets, MCP, sécurité
Neural Memory Engine (SQLite/FTS5 : district → départements → discussions ; 4 couches ; archives immuables ; contradictions historisées ; compactage vérifiable) · budgets locaux `/define-token`
(points/tokens, période, portée, épuisement, report ; réservations ; nature mesuré/estimé/saisi/indisponible) · MCP (`<données>/mcp.json`, stdio et HTTP, confirmation par appel).
Données : `~/.local/share/poe-neural-code/` · `%APPDATA%\poe-neural-code\` (surcharge `PNC_HOME`). **Aucune sandbox** : commandes et plugins tournent avec vos droits ; garde-fous = périmètre
du projet, confirmations avec aperçu, délais, `sudo` refusé, clé non transmise aux processus enfants. Voir [docs/LIMITES.md](docs/LIMITES.md).
