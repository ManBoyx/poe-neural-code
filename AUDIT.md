# Audit de /cg, /connect et de l'interface terminale d'Eclipse

Date : 22/11/2026. Base : commit `a31b15e` (4.0.0), plus des modifications **non commitées** du 21/11 qui ajoutent `/cg`. Aucune ligne de code n'a été modifiée pour cet audit. Sauvegarde faite avant : `~/Projets/_sauvegardes/poe-neural-code-avant-audit-cg-20261122-011201.tar.gz`.

Légende : **[vu]** constaté en lançant le programme ou en lisant une trace réelle · **[code]** déduit de la lecture du code · **[incertain]** à confirmer.

## 0. État constaté sur ce PC

| Élément | Constat | Preuve |
|---|---|---|
| Claude Code | 2.1.330, `~/.local/bin/claude` | `claude --version` |
| Codex CLI | 0.171.0, `~/.npm-global/bin/codex` (installé le 21/11, binaire **musl**) | `codex --version`, `ls -la ~/.npm-global/bin` |
| OpenCode, Gemini CLI | v2.1.4 (`~/.opencode/bin`), 0.65.0 (`/usr/local/bin`) | `eclipse agents` |
| Node, npm | Node 24.18.0, `/usr/bin/npm` | `node --version` |
| SDK de /cg | déjà installés dans `~/.local/share/poe-neural-code/cg-sdk/c7d963…` (claude-agent-sdk 0.3.309, codex-sdk 0.171.0) | `ls` du cache |
| Code de /cg | `cg.py`, `cg_sdk/`, `tests/test_cg.py`, `CLAUDE.md`, `AGENTS.md` non suivis par git ; 20 fichiers modifiés non commités | `git status` |
| Tests /cg existants | 11 réussis, mais tous avec des agents simulés | `pytest tests/test_cg.py` → `11 passed` |

Traces réelles de /cg sur ce PC (base `memory.db`, lue en lecture seule) :

- discussion 32 « salut » → `Claude Code (proposition) : SDK absent. Installez les dépendances…` ;
- discussion 34 « slt », « salut » → `SDK Codex indisponible : Cannot find package '@openai/codex-sdk'…` (deux fois) ;
- discussion 36 « salut » → seule la proposition de Claude Code est enregistrée. Codex a pourtant fini sa proposition (trace `~/.codex/sessions/2026/11/21/rollout-…22-49-47…jsonl`, `task_complete` à 22:50:49) après **211 000 tokens d'entrée**, modèle `gpt-6.2-sol`, effort `high`. Ensuite, plus rien : pas de rapport de Codex, ni erreur, ni bilan.

- discussion 38 (22/11, 18:45) « test » → proposition de Claude Code au bout de 19 s, puis « Échange interrompu » 34 s plus tard. Codex n'avait encore rien rendu ; sa trace `rollout-…-04ab7a15d895.jsonl` montre qu'il explorait encore le dossier.

## 1. /cg : bugs

| # | Symptôme | Cause | Fichier:ligne |
|---|---|---|---|
| CG1 | Premier message en échec « SDK absent » ou « Cannot find package '@openai/codex-sdk' » [vu] | /cg dépend de deux paquets npm installés au premier message (réseau requis), dans un cache hors du projet ; le contrôle `check` des versions précédentes pointait sur `src/…/cg_sdk` sans `node_modules`. | `cg.py:60-103`, `cg_sdk/run.mjs:56-70` |
| CG2 | Un simple « salut » lance 7 appels d'agents, et un seul coûte 211 000 tokens chez Codex [vu] | Chaque tour enchaîne toujours propositions ×2, concertation, répartition, exécution ×2, vérification et bilan, quelle que soit la demande. Chaque appel repart de zéro et relit le projet. | `cg.py:139-194` |
| CG3 | Tour bloqué ou perdu après la proposition de Claude Code (discussion 36) [vu, cause non établie] | `consult_both` attend les deux agents sans rien afficher. Rien n'est conservé si l'un échoue ou si la fenêtre est fermée. L'arrêt d'Eclipse n'annule pas le tour (CG7). | `cg.py:132-137`, `services.py:397-406` |
| CG4 | Aucun suivi en direct : on ne voit rien pendant des minutes, puis un bloc entier [code] | `_run` lit la sortie avec `communicate()` (tout à la fin). `run.mjs` utilise `thread.run()` et pas `runStreamed()`, et ignore les messages intermédiaires de Claude. | `cg.py:29-41`, `run.mjs:32,46-52` |
| CG5 | Sorties des deux agents mélangées dans un seul fil, dans l'ordre d'arrivée [code] | Chaque rapport devient un message Markdown « **Agent · phase** » dans le même `VerticalScroll`. Aucune zone par agent. | `ui/app.py:426-433` |
| CG6 | Codex absent : tout /cg échoue avec « Agent introuvable : Codex », sans indiquer comment l'installer [code] | Vérification seulement au moment d'envoyer le message, et sans mode dégradé. | `services.py:277-280` |
| CG7 | Processus orphelins possibles à la fermeture [code, incertain] | `Services.close()` n'annule pas `cg_task`. Les agents tournent dans une nouvelle session (`start_new_session`) : si le terminal est fermé (SIGHUP) ou si Eclipse est tué, ils ne reçoivent rien et continuent. | `services.py:397`, `platform_compat.py:85-89`, `cg.py:30-33` |
| CG8 | Délai fixe de 600 s par appel, pour tout [code] | Il n'y a pas de délai d'inactivité, et aucune distinction entre « l'agent travaille » et « l'agent ne répond plus ». Un long travail est tué ; un agent figé bloque 10 minutes. | `cg.py:45` |
| CG9 | Modèle et effort impossibles à choisir [code] [vu] | Aucun `model` ni `effort` n'est transmis. Codex prend `gpt-6.2-sol` et `high` dans `~/.codex/config.toml`, Claude prend `sonnet` dans ses réglages, à l'insu d'Eclipse. | `run.mjs:24-44` |
| CG10 | Consommation invisible : ni tokens, ni limite, ni points [code] | Aucun `UsageEvent` n'est émis en mode `cg`, et la consommation des deux agents n'est jamais lue. | `services.py:241-301` |
| CG11 | Deux agents peuvent écrire l'un après l'autre et défaire le travail de l'autre [code] | La répartition peut mettre `write: true` pour les deux. L'ordre est séquentiel, mais rien n'impose « un seul écrit, l'autre relit ». | `cg.py:153-187` |
| CG12 | En lecture, Claude est lancé en mode `plan` [code] | Ce mode sert à planifier avant d'agir, pas à lire seulement. La lecture seule est déjà garantie par la liste d'outils. Le résultat peut être un plan au lieu d'un rapport. | `run.mjs:42` |
| CG13 | Interruption (Échap) peu sûre [code] | `interrupt_cg` annule la tâche du tour entier et avale `CancelledError` sans `uncancel()`. La suite (`turn_done` des plugins, pile d'annulation) s'exécute dans une tâche marquée annulée. | `services.py:237-239, 289-291` |
| CG14 | Répartition rejetée si l'agent ajoute du texte autour du JSON, et `lines[0]` plante sur une réponse vide [code] | Analyse naïve (bloc ``` exact ou JSON pur). L'`IndexError` n'est pas rattrapé. | `cg.py:159-170` |
| CG15 | Clés d'API transmises aux agents [code] | Seul `POE_API_KEY` est retiré de l'environnement. Si `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` sont définis, Claude ou Codex basculent sur la facturation API au lieu de l'abonnement, sans le dire. | `cg.py:46-47, 77-78` |
| CG16 | Erreurs brutes en anglais à l'écran (pile Node, message du SDK) [vu] | Les 1 200 derniers caractères de stderr sont affichés tels quels. | `cg.py:54-56` |
| CG17 | Pendant /cg, `/connect`, `/model`, `/effort`, `/retry` et `/compact` agissent sur l'agent Poe caché, pas sur /cg [code] | `Services.runner` renvoie `self.agent` pour le mode `cg`, et `set_mode` fait sortir de /cg sans le dire. | `services.py:118-135, 175-180` |
| CG18 | Choix « Claude Code pilote / Codex pilote / Collaboration » obligatoire avant tout message, sans explication de la différence réelle [vu dans les tests] | Ce choix ne change que l'agent qui répartit et fait le bilan. | `ui/app.py:879-889`, `cg.py:146-152` |
| CG19 | Hors /cg, `CLAUDE.md` du dépôt demande à Claude Code d'appeler automatiquement Codex pour relire, et `AGENTS.md` l'inverse [code] | Toute session Claude Code ou Codex ouverte dans ce dépôt peut déclencher l'autre agent (coût caché, boucle possible). | `CLAUDE.md`, `AGENTS.md` |

## 2. /cg : ce que la demande exige et qui n'existe pas

- Coordinateur qui découpe la demande et attribue les sous-tâches selon les forces de chacun : il n'y a qu'un appel « répartition » générique en deux parts.
- Une seule écriture à la fois, l'autre agent relit : pas garanti (CG11).
- Deux zones étiquetées en direct : rien (CG4, CG5).
- Modèle, effort et « puissance » par agent, modifiables en cours de session, enregistrés : rien (CG9). Le sens de « puissance » est à préciser (voir le plan).
- Détection au lancement de /cg, avec le message d'installation de l'agent manquant : non (CG6).
- Voix : rien (section 5).
- Annulation propre et aucun processus orphelin : non garanti (CG7, CG13).
- Tests réels : aucun ; les 11 tests simulent les agents.

## 3. /connect

- **[vu] Le bug « seul Gemini est détecté » n'existe plus avec le code actuel.** `eclipse agents`, lancé dans un terminal et dans l'environnement d'une application du menu (`systemd-run --user`), trouve Claude Code, OpenCode, Gemini CLI et Codex CLI. L'écran d'accueil du TUI, lancé de la même façon, affiche « Agents IA détectés : Claude Code, OpenCode, Gemini CLI, Codex CLI ». Codex est trouvé via le PATH du shell (`~/.zprofile`, `~/.zshrc`).
- **CX1 [vu]** Depuis l'environnement du menu, Gemini CLI est noté « `--version` sans réponse en 5 s ». Les versions sont lues en parallèle et Gemini démarre lentement. Délai trop court : `cli_agents.py`, `_version(…, timeout=5.0)`.
- **CX2 [vu]** L'écran d'accueil conseille « /connect pour brancher un agent », mais son seul champ est le chemin du dossier. Taper `/connect` puis Entrée ne lance pas la commande : Eclipse cherche un dossier nommé `/connect`. `ui/app.py:116, 122-127`.
- **CX3 [code]** Dans une discussion /cg, choisir un agent dans /connect quitte /cg sans prévenir (CG17). Les deux écrans ne partagent ni la détection ni les réglages par agent.
- **CX4 [code]** OpenCode : seul le programme local est utilisé comme agent (bien). OpenCode Zen et Go figurent aussi dans le bloc « clé d'API ». C'est correct mais peut prêter à confusion ; le libellé devra le préciser.

## 4. Interface terminale (Textual 8.2.8)

Défauts constatés en pilotant le vrai TUI dans un pseudo-terminal de 120×40, puis 80×24, ou trouvés à la lecture :

| # | Défaut | Fichier:ligne |
|---|---|---|
| T1 | **Défilement forcé** : chaque morceau de réponse, chaque outil et chaque message ramène tout en bas (`scroll_end`). Impossible de relire plus haut pendant qu'un agent écrit. [code] | `ui/app.py:292, 425, 463` |
| T2 | **Rendu du flux coûteux** : toutes les 80 ms, le Markdown entier est réanalysé et reconstruit (`Markdown.update(buffer)`). Ça ralentit et peut scintiller sur les longues réponses. [code] | `ui/widgets.py:35-48` |
| T3 | **Fil sans limite** : chaque message reste un widget monté ; les longues sessions ralentissent. Une sortie d'outil est coupée à 10 lignes sans moyen de tout lire au clavier (clic seulement). [code] | `ui/app.py:287-292`, `ui/widgets.py:107-116` |
| T4 | **Redimensionnement** : après passage de 120×40 à 80×24, l'écran capturé mélange l'ancien et le nouveau rendu, et la barre latérale reste affichée sous 100 colonnes. [vu en pseudo-terminal, **incertain** : à confirmer dans Alacritty] | `ui/app.py:400-401` |
| T5 | **Échec affiché comme succès** : « Aucun modèle sélectionné » est suivi d'un pied de tour vert « OK 0,1 s ». Seul /cg signale ses échecs. [vu] | `agent.py:227-232, 268`, `ui/app.py:488-494` |
| T6 | **Messages contradictoires** : l'accueil dit « Poe prêt » alors qu'aucun modèle n'est choisi. Il conseille `/models`, l'erreur dit `/model`. L'erreur de clé ne parle que de la variable `POE_API_KEY`, alors que la clé est dans le trousseau. [vu] | `ui/app.py:259-264`, `agent.py:228-231` |
| T7 | **Reprise de session tronquée** : les messages précédents ne sont affichés que sur une ligne de 150 caractères, sans Markdown ni auteur pour /cg. [code] | `ui/app.py:232-238` |
| T8 | **Raccourcis incohérents** : Ctrl+C vide ou quitte mais n'interrompt jamais ; Échap interrompt. Tab change de mode depuis la zone de saisie, sauf si l'aperçu est ouvert. Maj+Entrée dépend du terminal (Ctrl+J marche, vérifié). [vu pour Ctrl+J, **incertain** pour Maj+Entrée dans Alacritty] | `ui/app.py:154-168`, `ui/widgets.py:190-199` |
| T9 | **Erreurs avalées** : 12 `except Exception: pass` dans `ui/app.py`. Une panne de rafraîchissement ou de modèle ne laisse aucune trace. [code] | `grep -n "except Exception" ui/app.py` |
| T10 | **Activité peu lisible** : une seule ligne « ⠋ activité… » pour tout. En /cg, elle n'indique que la dernière phase lancée, alors que deux agents travaillent en parallèle. [code] | `ui/app.py:390-398, 434-435` |
| T11 | **Rafraîchissement global chaque seconde** : 7 panneaux reconstruits, avec des requêtes SQLite de budget, même au repos. [code] | `ui/app.py:245, 368-388` |
| T12 | **Fichier monolithique** : `ui/app.py` fait 1 897 lignes ; écran, commandes, connexions et sélecteurs y sont mêlés. Les modules demandés (orchestration, détection, réglages, interface, voix) ne sont pas séparés. [code] | `ui/app.py` |
| T13 | **Tests qui écrivent dans le vrai journal** : `~/.local/share/poe-neural-code/pnc.log` contient des « ERROR plugin bad : boum » écrits par la suite de tests. [vu] | `tests/` (isolation de `logs_dir`) |

## 5. Mode vocal : ce que proposent réellement les versions installées

- **Claude Code 2.1.330** : il a un `/voice` (« Enable voice mode (hold-to-talk dictation) »), mais seulement dans son interface interactive. La transcription passe par le service d'Anthropic et le compte connecté, avec SoX ou arecord. `claude --help` ne propose aucune option vocale pour `-p` ni pour le SDK. Le SDK contient une requête de transcription marquée `@internal` (non documentée, à ne pas utiliser). **Conclusion : pas de voix utilisable depuis Eclipse.** Preuve : `strings` sur `~/.local/share/claude/versions/2.1.330`, et `claude --help | grep -ci voice` → `0`.
- **Codex CLI 0.171.0** : `codex features list` affiche `in_app_voice stable true`. Il y a un `/voice` (conversation vocale en temps réel, liée au compte ChatGPT) dans son interface interactive. **[vu] Elle marche sur ce PC** : la trace `~/.codex/sessions/2026/11/22/rollout-…-debd15ac8bb6.jsonl` (22/11, 18:47, `originator: codex-tui`) contient une conversation vocale transcrite (`<realtime_delegation>` avec `transcript_delta`). Le binaire est pourtant la version musl, malgré le message « Voice requires … a glibc-based Linux build » trouvé dans le programme : ma première lecture, qui concluait à une voix indisponible, était fausse. `codex exec` n'a en revanche aucune option vocale. **Conclusion : voix réelle dans la fenêtre de Codex, mais inutilisable depuis Eclipse, qui pilote Codex en mode non interactif.**
- **Matériel et outils présents** : `arecord`, `sox`/`rec`, `pw-record` et `parecord` sont installés. Aucun moteur de transcription local (`whisper`, `whisper-cli`, `faster-whisper`) n'est présent.
- **Solutions possibles** (à toi de choisir) :
  1. transcription locale : whisper.cpp ou faster-whisper, avec un modèle à télécharger (environ 150 Mo à 1,5 Go). Gratuit, hors ligne, plus lent sur un processeur seul ;
  2. transcription par API : Groq (Whisper, rapide, offre gratuite limitée) ou OpenAI, avec la clé dans le trousseau ;
  3. dans les deux cas, enregistrement avec `pw-record` ou `arecord` sur une touche (appuyer pour parler), puis envoi du texte transcrit, affiché et modifiable avant envoi, à /cg comme une saisie normale.

## 6. Ce qui n'a pas été vérifié

- Aucun /cg réel lancé pour l'audit : chaque tour coûte des appels sur les abonnements Claude et Codex. Les symptômes CG1 à CG3 viennent des traces du 21/11.
- Rendu dans Alacritty (T4, T8) : vu seulement dans un pseudo-terminal émulé (pyte).
- Desktop : `/cg` y existe aussi (modifications non commitées de `app.tsx`). Il n'a pas été audité en détail, la demande portant sur le terminal.
