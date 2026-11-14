# Limites connues et état des fonctionnalités

## Opérationnel et testé (218 tests automatisés)
- Connecteur Poe (streaming, appels d'outils natifs, usage tokens, erreurs HTTP) — **contre un faux serveur HTTP uniquement**.
- Boucle d'agent de bout en bout (outils, autorisations, diff, interruption, reprise de session) — avec un fournisseur de **test scripté**.
- Neural Memory Engine : persistance, archives immuables, recherche FTS5 filtrée, cache de travail, contradictions, compactage
  segment/département/district, vérification des résumés, contexte borné.
- Budgets locaux : renouvellement, persistance, partage, réservations, pause, alertes, distinction mesuré/estimé/saisi/indisponible.
- MCP : vrai serveur stdio (SDK officiel 2.x) — découverte, validation, confirmation, délai, déconnexion/reconnexion, réponse hostile.
- Interface Textual : accueil, sidebar, redimensionnement, modales, `/define-token`, interruption (tests pilotés + capture vérifiée).

## Mode Claude Code
- Testé : faux `claude` rejouant le format stream-json réel (13 tests, pont MCP HTTP réel) **et un test réel** (haiku, un appel `list_dir` via le pont ;
  tokens et fenêtres d'abonnement lus). Le chemin « confirmation d'une commande » avec le vrai `claude` n'a pas été rejoué (couvert avec le faux + mêmes outils).
- Le pont s'appuie sur le comportement observé de Claude Code 2.1.319 (`--tools ""`, `--permission-prompts none`, `--strict-mcp-config`) ; une mise à jour
  peut le changer. Garde-fou : si un outil intégré apparaît à l'init, le tour est arrêté.
- Les tokens de la limite excluent le cache relu ; l'abonnement peut les compter autrement : la fenêtre 5 h/7 j mesurée par Claude Code fait foi.
- Pas de streaming des appels d'outils côté Claude (seuls les événements d'Eclipse sont affichés).

## Interface OpenCode, extensions, réglages par modèle
- Testé (tests pilotés Textual + captures vérifiées) : aperçu des commandes, `@fichier`, `!shell`, leader Ctrl+X, Tab/modes, Ctrl+T, aide, thèmes, `/undo`/`/redo` avec un vrai dépôt Git,
  plugins (approbation par empreinte, hooks), skills, commandes personnalisées, sous-commandes CLI.
- **`/undo`** : fichiers restaurés seulement dans un dépôt Git (instantané via index temporaire) ; les fichiers ignorés par `.gitignore` ne sont pas suivis. En mode Claude, annuler repart d'une
  nouvelle session Claude (le tour annulé est exclu de la mémoire Eclipse). Les effets externes d'une commande (réseau, base de données) ne sont évidemment pas annulables.
- **Sous-agents** : listés (`mode: subagent`) mais pas de délégation (outil Task) ; **`/share`, `/unshare`**, `/details` fin, rename/delete de session depuis la liste, fork : non réalisés.
- **Skills** : pas de `!commande` ni de pièces jointes dans les modèles de commandes personnalisées ; skills de projet = contenu non fiable (confirmation à chaque chargement de session).
- **Plugins Python** (pas JavaScript/TypeScript comme OpenCode) : API propre à Eclipse ; aucune sandbox ; un plugin approuvé a tous vos droits.
- **Réglages par modèle** : valeurs permises lues du catalogue ; l'effet réel côté fournisseur n'est pas vérifié ici (pas de clé Poe) ; Claude Code peut refuser `--effort` selon le modèle.
- `/update` ne met rien à jour (pas de canal de publication) ; `/connect` ne gère pas les clés (hors périmètre) ; `/editor` et `/export` ouvrent `$EDITOR` (suspension du terminal, non testé en automatique).
- La réservation de budget (pire cas = max_tokens × prix) peut refuser une requête avec un petit budget et un modèle cher : augmentez le budget ou baissez `max_output_tokens`.
- Windows toujours non testé.

## Connexions multi-fournisseurs et agents externes
- **Testé en réel** : détection des agents (Claude Code, OpenCode, Gemini CLI installés ici), adaptateur OpenCode (texte, session reprise, tokens estimés), catalogue public OpenRouter/Poe.
  **Tests automatisés** : connecteur générique (faux serveur), stockage des clés, lanceur délégué (faux agent), parcours `/connect` dans l'interface.
- **Aucun appel de chat réel** avec les API OpenAI, Anthropic, Groq, Mistral, DeepSeek, xAI, Together, Google, ni avec Poe (pas de clés) : les adresses répondent (401 sans clé) mais le chat est
  couvert seulement par des faux serveurs. L'adresse Google Gemini n'a pas pu être vérifiée (404 sans clé). Hors OpenRouter, prix/contexte/outils des modèles sont souvent inconnus : affichés « indisponible ».
- **Gemini CLI** est installé mais inutilisable ici (Google a retiré l'accès individuel) ; **Codex** et **Kiro** ne sont pas installés : leurs options sont des hypothèses étiquetées « NON vérifiées ».
- **Mode délégué** : pas d'aperçu ni de confirmation des commandes de l'agent externe ; tokens ESTIMÉS (caractères/4) sans compteur ; la limite est appliquée sur l'estimation (arrêt du processus). Un agent
  peut avoir sa propre sandbox/approbation : Eclipse ne la pilote pas (OpenCode est lancé sans `--auto`).
- **Clés** : fichier non chiffré à droits 600 si le trousseau système n'est pas disponible ; elles ne sont jamais journalisées ni transmises aux processus enfants (POE_API_KEY retirée de leur environnement).
- Les points sont propres à Poe ; ailleurs le budget en points n'existe pas (limites de tokens uniquement).

## Bypass, /effort, fusion
- **Bypass** : testé (gestionnaire de permissions, outils, agents délégués avec faux agent, interface). Aucune sandbox : en bypass, commandes et plugins ont tous vos droits. `sudo` est refusé en toute circonstance ; les
  destructifs/hors projet restent confirmés sauf `/bypass all`. Détection du « destructif » et du « hors projet » par **heuristiques** (contournables). `--auto` (OpenCode) et `yolo` (Gemini) : transmis seulement en bypass ; Gemini non testé ici.
- **/effort** : niveaux lus du catalogue du modèle actif (Poe : `reasoning_effort`, etc.) ; Claude Code : `low…max` ; agents délégués : aucun réglage. L'effet réel chez le fournisseur n'est pas vérifié.
- **Fusion** : testée avec un faux agent, un faux serveur API, un faux `claude`, et **en réel avec OpenCode** (consultation seule, sans modèle principal). Non testé en réel : Claude Code comme assistant ou comme demandeur de bout en bout,
  Kiro/Codex/Gemini (non installés ou inutilisables), API par clé. Tokens des assistants CLI sans compteur = **estimés**. Les agents délégués ne peuvent pas initier de consultation. Le texte envoyé à un assistant quitte
  l'application : relisez l'aperçu.

## Version 0.2.0
- **Testé** (tests automatisés + captures vérifiées) : saisie multiligne et historique, barre d'état, pied de tour, onglets, blocs repliables, diffs appliqués, `/free` (sources réelles détectées), `/models free`,
  images (faux serveurs et faux `claude`), `web_fetch` (faux serveur), paramètres standard, `/add-dir`, `/system`, `/fork`, suppression de session, `/config`, `/doctor`, `/context`.
- **Non testé en réel** : images avec un vrai modèle (Poe/OpenRouter sans clé ici ; Claude Code non relancé pour préserver votre fenêtre d'usage), `web_fetch` sur Internet, téléchargement Ollama,
  offres gratuites Groq/Google/Mistral/Cerebras/GitHub (pas de clés ; adresses Cerebras/GitHub/Google non confirmées).
- **OpenCode gratuit** : seulement via l'agent OpenCode (mode délégué) ; leur API refuse les modèles gratuits hors d'OpenCode et Eclipse ne contourne pas cette règle.
- **Paramètres d'échantillonnage** : pour les fournisseurs sans liste (OpenAI…), temperature/top_p/seed sont proposés comme « standard OpenAI, prise en charge non vérifiée ».
- **web_fetch** : pas de moteur de recherche intégré (utilisez le réglage `web_search` du modèle quand il existe) ; pages lourdes tronquées ; HTML converti en texte simplement.
- La touche Maj+Entrée dépend du terminal (sinon Ctrl+J ou Alt+Entrée). Windows toujours non testé.

## Non vérifié ou non réalisé
- **Aucun appel réel à Poe n'a été fait** (pas de clé de test). `stream_options.include_usage` n'est pas documenté pour Poe : repli sans
  l'option sur HTTP 400, puis tokens estimés.
- **Points par requête** : non fournis par l'API de complétion → jamais « mesurés » ; estimés seulement si prix du modèle ET taux saisi.
  Récupération du solde/historique du compte : hors périmètre (à définir plus tard).
- Réservation **majorante** (max_tokens × prix) : prudente, peut refuser une requête qui aurait coûté moins. Coût d'entrée = estimation
  (~4 caractères/token). Plafond exact non garanti sans prix ou sans taux (indiqué).
- Conditions de cache fournisseur : non modélisées (équivalent en tokens donné hors cache).
- Recherche sémantique : **non intégrée** (recherche textuelle FTS5 uniquement ; interface prête à être étendue).
- Résumés : extractifs/reconstruits localement ; un résumé rédigé par un modèle n'est pas implémenté (à vérifier avec `/verify` le cas échéant).
  Aucune garantie d'absence de perte, aucune comparaison avec d'autres produits.
- Détection de contradictions : par clé explicite (`key`) pour faits/décisions/contraintes ; pas de détection sémantique.
- Extraction automatique d'items : marqueurs explicites (« Décision : », « TODO : »…) dans les messages user/assistant ; jamais depuis des sorties d'outils.
- **Pas de sandbox.** Détection de chemins/commandes destructifs = heuristiques (contournables) ; la confirmation reste la vraie barrière.
- **Windows non testé** (code sans dépendance POSIX ; arrêt d'arbre via `taskkill`).
- Multi-fournisseur, passerelle, multi-comptes, gestion des clés : volontairement hors périmètre.
- Les agents tournent un tour à la fois ; pas de tâches d'arrière-plan simultanées (les réservations les prépareraient).
