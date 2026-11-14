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
**Utilisateurs** : applications Linux (AppImage, .deb, .rpm), Windows (installateur, MSI, portable, Scoop) et Android.
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
| `/connect` | | choisir/vérifier le fournisseur (Poe, Claude Code) |
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

Propres à Eclipse : `/agents` `/mode NOM` (Tab / Maj+Tab) · `/provider ID` · `/effort` (**Ctrl+T**) `/options` · `/permissions` `/bypass` (Ctrl+X P) · `/fusion` · `/usage` (Ctrl+X I) · `/status` · `/sidebar` · `/details` ·
`/timeline` · `/copy` · `/rename` · `/skills` · `/plugins` · `/mcp` · `/memory` · `/verify` · `/todo` · `/define-token` · `/claude-limit` · `/rate` · `/spent` · `/reload`.
Autres touches : Échap interrompre · Ctrl+P palette · Ctrl+C vider/quitter · PgHaut/PgBas · F2 modèle récent.

## Réglages selon le modèle actif (effort, recherche web, réflexion…)
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

## Connexions : n'importe quel agent installé ou fournisseur par clé d'API (`/connect`)
`/connect` (ou `eclipse agents`, `eclipse providers`, `eclipse login ID`) détecte automatiquement les agents IA installés sur l'ordinateur et propose les fournisseurs API.
Tous passent par la **maîtrise des tokens d'Eclipse** (journal mesuré/estimé, limite avant et pendant le tour, alertes, pause, interruption).
- **Agents installés** : *Claude Code* (intégration complète : outils d'Eclipse, aperçu, confirmation), *OpenCode* (testé en réel), *Gemini CLI*, *Codex*, *Kiro*
  (préréglages non vérifiés, étiquetés) et vos propres agents via `<données>/agents.json`. **Mode délégué** pour les agents autres que Claude Code : l'agent exécute ses PROPRES
  outils (Eclipse ne peut pas en prévisualiser les commandes — annoncé), tokens mesurés si l'agent les donne sinon **estimés**, mode `plan` transmis si l'agent a une option lecture seule.
- **API par clé** : Poe, OpenRouter, OpenAI, Anthropic (API), Google Gemini, Mistral, Groq, DeepSeek, xAI, Together, Ollama et LM Studio (locaux), ou toute adresse compatible OpenAI
  (« Autre fournisseur »). Vous saisissez la clé (masquée) ; elle est vérifiée puis stockée (trousseau du système si `keyring` est installé, sinon fichier à droits 600, non chiffré). Les modèles
  du fournisseur apparaissent aussitôt dans `/models`. Hors Poe : pas de « points », mais USD estimé (prix du catalogue × tokens mesurés) et limites de tokens. `/disconnect ID` oublie une clé.

## Consommation : `/usage` et panneau latéral
Même ordre logique partout : **fournisseur/modèle → cette session → budget (points, tokens, temps) → abonnement Claude (fenêtres 5 h/7 j) → totaux locaux** ; une ligne par *nature* de valeur
(`[mesuré]`, `[estimé]`, `[saisi]`, `[indisponible]`, jamais additionnées). `/usage` (Ctrl+X I) ajoute les tableaux aujourd'hui / semaine / mois **par modèle ou agent**, y compris les assistants consultés en fusion.

## Permissions : `/permissions`, `/bypass`
`ask` (tout confirmer, par défaut) · `edits` (modifications de fichiers du projet acceptées d'office) · **`bypass`** (plus aucune confirmation : commandes, MCP, plugins, skills, fusion…).
Planchers : `sudo` reste **toujours refusé** ; les actions **destructrices** ou **hors du projet** redemandent confirmation, sauf **`/bypass all`** (choix explicite et distinct). L'activation demande une confirmation,
un badge rouge « ⚠ BYPASS » reste affiché, et le mode **n'est jamais conservé** au redémarrage. Pour les agents externes délégués, Eclipse transmet leur option « sans confirmation » (OpenCode `--auto`, Gemini `yolo`)
seulement en bypass et jamais en mode plan. En ligne de commande : `eclipse run --bypass …`.

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
