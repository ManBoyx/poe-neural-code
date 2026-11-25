# Plan : Eclipse réécrit en TypeScript (Bun + OpenTUI), interface façon OpenCode

Décisions de l'utilisateur (25-26/11/2026) :
- interface terminale façon OpenCode, conçue pour Eclipse, sans copier le code d'OpenCode ;
- **tout** Eclipse est converti dans les langages d'OpenCode : TypeScript, exécuté par Bun, interface en OpenTUI (`@opentui/core` et `@opentui/solid`, version 0.9.9 sur npm le 26/11) ;
- `/cg` pilote directement `claude` et `codex`, sans les SDK npm.

Vérifié sur ce PC le 26/11 : Node 26.13.1 et npm 12.2.3 présents, **Bun absent**. OpenTUI 0.9.9 demande Bun ≥ 1.3.14 ou Node ≥ 26.4.

## Règles pour chaque étape

- Avant : commit sur la branche `ts-refonte` (jamais poussée sans accord) et copie tar.gz dans `~/Projets/_sauvegardes`.
- Après : commandes lancées et sortie réelle, avec ce qui est fait, ce qui ne l'est pas, ce qui est incertain.
- Le Python reste en place et utilisable jusqu'à l'étape 11. On peut revenir en arrière à tout moment.
- Les données restent compatibles : même dossier `~/.local/share/poe-neural-code` (sessions, `memory.db`, `budget.db`, `config.json`) et clés dans le même trousseau. Tu gardes ton historique.
- Tests automatiques avec `bun test`. Les vrais agents et fournisseurs payants ne servent qu'aux essais annoncés, au modèle et à l'effort les moins chers, avec la consommation mesurée.

## Étapes

| # | Étape | Contenu | Preuve attendue |
|---|---|---|---|
| 0 | Mise à l'abri et outils | Branche `ts-refonte`, sauvegarde, Bun installé dans `~/.bun` (installateur officiel, sans sudo). Dossier `ts/` : `engine` (moteur), `tui` (interface), `shared` (types communs). | `bun --version`, squelette qui compile, premier `bun test` |
| 1 | Socle | Chemins, configuration, journaux (jamais de secret), trousseau (Secret Service sous Linux, Gestionnaire d'identification sous Windows), relecture des données actuelles. | Tests ; lecture de ta vraie config et de tes sessions sans les modifier |
| 2 | Fournisseurs | **Aucun fournisseur imposé** : au premier lancement, et à tout moment avec `/provider`, on choisit son fournisseur (clé d'API, serveur local ou agent CLI installé). Poe apparaît dans les **fournisseurs recommandés**. Le choix est enregistré. Les messages ne parlent plus de Poe quand un autre fournisseur est actif. Poe corrigé (P1 à P6 de l'audit) ; OpenAI, OpenRouter, Anthropic, Groq, Mistral, Cerebras, GitHub Models, OpenCode Zen et Go ; LM Studio, Ollama, URL personnalisée ; effort rapide, normal, profond. | Faux serveur dans les tests ; vrai catalogue Poe (gratuit) : les 299 modèles reconnus |
| 3 | Outils et permissions | Fichiers, commandes (arrêt de tout l'arbre de processus), web, confinement au dossier, permissions, annuler et rétablir, tâches. | Tests, dont refus hors du dossier et arrêt d'une commande |
| 4 | Agent, mémoire, budget | Boucle de l'agent, mémoire SQLite (même schéma), compactage, budget en points et tokens, sessions. | Tests ; ancienne mémoire relue à l'identique |
| 5 | Agents CLI et MCP | Détection des 14 agents (PATH du shell, dossiers connus, chemin manuel), Claude Code, agents délégués, mémoire Eclipse par MCP, client MCP, fusion, modèles gratuits. | Tests ; `eclipse agents` trouve Claude Code, OpenCode, Gemini et Codex |
| 6 | `/cg` refait | Voir « Conception de /cg » plus bas. | Faux agents dans les tests, puis un vrai essai court de chaque agent |
| 6 bis | Permissions et bypass | Voir « Permissions » plus bas. | Tests ; essai réel de la demande de mot de passe |
| 7 | Serveur local et desktop | Mêmes routes que le serveur actuel, pour que l'appli desktop marche sans changement d'interface. Le moteur est compilé en un seul fichier (`bun build --compile`) à la place de PyInstaller. | Tests e2e du desktop repassés sur le nouveau moteur |
| 8 | Interface OpenTUI façon OpenCode | Accueil, discussion, zone de saisie, liste `/`, palette Ctrl+P, sessions Ctrl+X L, modèles Ctrl+X M, Connexions en 3 blocs, demandes d'autorisation, `/cg` en deux zones. Défilement, redimensionnement, historique, saisie multiligne. L'interface est cliente du moteur local, comme chez OpenCode. **Maquette montrée avant le code.** | Captures en texte dans un vrai pseudo-terminal, puis contrôle par toi dans Alacritty |
| 9 | Commandes | Toutes les commandes `/` actuelles, avec aide intégrée. | Tableau des commandes, ancien et nouveau |
| 10 | Voix | Module séparé, selon ton choix de transcription. | Essai réel au micro |
| 11 | Bascule | `eclipse` lance la version TypeScript ; Python retiré seulement après la liste de parité et ton accord ; paquets AppImage, deb, rpm et Windows ; README et CHANGELOG. | Suite complète, e2e, lancement depuis le terminal et depuis le menu |
| 12 | Bilan | Ce qui marche, ce qui ne marche pas, ce qui reste ; guide de `/cg`. | |

## Choix du fournisseur et du modèle (`/provider`, `/models`, premier lancement)

Demandé le 26/11 :
- **Barre de recherche** en haut : « Rechercher d'autres modèles… ». Elle cherche dans tous les catalogues connus (Poe, OpenRouter, OpenAI, serveurs locaux, etc.) ; un fournisseur dont la clé manque propose de la saisir.
- **Récemment utilisés** : plusieurs modèles, du plus récent au plus ancien, avec leur fournisseur. La section n'apparaît que si on en a déjà utilisé.
- **API recommandées** : Poe, et les autres à décider.
- **Détectés sur cet ordinateur** : tout ce qu'Eclipse trouve tout seul, comme Claude Code, Codex, OpenCode, Gemini CLI, ou LM Studio et Ollama s'ils tournent.
- Couleurs douces mais visibles, une par section, toujours les mêmes, lisibles en thème sombre comme clair. Aucune emoji, des icônes Nerd Font.

## Conception de /cg (d'après les pratiques publiées, recherche du 26/11)

Sources lues : guide Nimbalyst, Addy Osmani (« The Code Agent Orchestra »), zetbrush/multiagents, Aseem Shrey (revue itérative de plan), le greffon officiel d'OpenAI `openai/codex-plugin-cc`, alexzh3/codex-orchestrator. Ce qui revient partout, et que je reprends :

1. **Tri d'abord.** Une question ou une petite demande va à un seul agent, sans boucle (« skip the loop for small changes »). La boucle complète n'est lancée que pour un vrai travail.
2. **Rôles séparés.** Un agent planifie et vérifie, l'autre exécute, et ça peut s'inverser selon la tâche. Par défaut, Claude Code planifie et vérifie, Codex exécute et relit. Le coordinateur peut choisir l'inverse, et tu peux l'imposer.
3. **Un seul écrit, l'autre ne peut que lire.** Le relecteur est lancé en lecture seule par ses propres options (`codex -s read-only`, outils de lecture seuls chez Claude Code). Dans un dépôt git, l'agent qui écrit travaille dans une **copie de travail séparée** (`git worktree`). Ses changements ne sont reportés dans ton dossier qu'après la relecture et ton accord. Hors git, Eclipse fait une sauvegarde avant et après, comme pour l'annulation.
4. **Boucle bornée avec un verdict explicite.** Le relecteur conclut par `VERDICT: APPROUVÉ` ou `VERDICT: À REVOIR`, avec fichier et ligne. On fait au plus 3 tours, puis le désaccord t'est présenté, avec les preuves de chacun et non un vote.
5. **Reprise de la même session entre les tours**, au lieu de tout renvoyer : `claude --resume ID`, et côté Codex la même conversation. Ça coûte moins de tokens et le contexte n'est pas perdu.
6. **Suivi en direct par flux :** `claude -p --input-format stream-json --output-format stream-json` et, côté Codex, `codex app-server` (JSON-RPC : démarrer, arrêter un tour, compter les tokens). Si ce mode, marqué expérimental, pose problème, Eclipse passe à `codex exec --json`, à vérifier sur la version installée.
7. **Délais d'attente.** Sans signe de vie pendant 60 s et sans commande en cours, l'agent est relancé une fois, puis arrêté. La durée maximale par tour est réglable. Échap arrête tout proprement, et les processus sont tués aussi si Eclipse se ferme.
8. **Coût.** `ANTHROPIC_API_KEY` et `OPENAI_API_KEY` ne sont pas transmises aux agents, pour rester sur tes abonnements. Les tokens de chaque agent sont affichés en direct.
9. **Instructions communes.** Les sources recommandent un seul fichier : `AGENTS.md` comme source, et `CLAUDE.md` qui l'importe (`@AGENTS.md`). Pendant `/cg`, Eclipse donne à chaque agent son rôle exact et lui interdit d'appeler l'autre lui-même.

Pour chaque agent, tu peux changer le modèle, l'effort et la puissance pendant la session. La puissance va de la lecture seule aux modifications, puis aux commandes, et jusqu'au bypass si tu l'as validé. Les réglages sont enregistrés.

## Permissions

- On lance simplement `Eclipse`, sans option particulière.
- `/perm` (et `/permissions`) propose tous les modes : demander à chaque fois, modifications acceptées d'office, lecture seule, bypass, bypass total.
- Le bypass demande le **mot de passe de l'ordinateur**. Sous Linux, c'est la fenêtre d'authentification du système qui le vérifie (polkit, la même que KDE affiche pour les actions d'administration) : Eclipse ne le voit jamais. Sans cette fenêtre, Eclipse affiche un champ masqué et le fait vérifier par `sudo -v`, sans l'enregistrer ni l'écrire dans un journal.
- Une fois validé, le bypass reste actif jusqu'à la fermeture d'Eclipse. Il s'applique aussi aux agents de `/cg`, avec leurs propres options de bypass.
- Windows : demande d'identité de Windows. Prévu, mais pas testable ici.

## Voix (plus tard, étape 10)

Principe demandé :
- avec Claude Code, sa voix ;
- avec Codex, la sienne ;
- sinon, whisper (installation avec sudo autorisée) ou une API.

Point à vérifier honnêtement à cette étape : les voix de Claude Code et de Codex ne marchent aujourd'hui que dans leurs propres fenêtres. Les utiliser depuis Eclipse demanderait des accès non documentés. Je vérifierai ce qui est possible sans contourner leurs conditions, puis je te le présenterai.

## Risques connus

- Chantier long : environ 11 700 lignes de Python et 346 tests à réécrire.
- OpenTUI est en version 0.x : son interface de programmation peut changer. La version sera fixée exactement.
- L'appli Android passe par SSH vers le PC (test `SshIntegrationTest.kt`). La commande `eclipse` garde son nom et ses options ; c'est à revérifier à l'étape 11.
- Windows : prévu (Bun et le trousseau Windows), mais il ne sera pas testé sans machine Windows.
