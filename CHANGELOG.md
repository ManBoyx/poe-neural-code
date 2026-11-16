# Journal des versions

## Non publié
### Connexions
- OpenCode Zen et OpenCode Go par clé d'API (`/connect` dans le CLI, Connexions dans l'application desktop ;
  variable `OPENCODE_API_KEY` possible). Seuls les modèles au format OpenAI sont proposés (16 pour Zen, 20 pour Go
  aujourd'hui) ; les modèles gratuits de Zen restent réservés à OpenCode (`/free`), comme l'exige OpenCode.
  Eclipse s'identifie (`eclipse/VERSION`) et envoie un identifiant de session stable par conversation, condition
  d'usage d'OpenCode Go. Le catalogue étant public, une clé erronée n'est signalée qu'au premier message.
- Archives autonomes du CLI (Linux, Windows) et workflow « Préversion privée ».

## 0.3.0 — 2026-11-16
### Eclipse Desktop : application de chat (le CLI garde son interface terminal)
- Interface graphique façon application de chat : conversations par dossier, fil avec Markdown nettoyé et code coloré,
  étapes d'outils dépliables avec diffs, cartes d'autorisation (une fois, pour la session, refuser), choix du modèle et
  de l'effort, modes Build/Plan, thèmes sombre et clair. Le moteur tourne en arrière-plan sur 127.0.0.1 avec un jeton ;
  `eclipse web` ouvre la même interface dans le navigateur.
- « Nouvelle discussion » : un dossier de travail est créé automatiquement (`~/Projets/Eclipse/…`, réglable).
- Panneaux Mémoire (notes par type, recherche, modifier, épingler, oublier), Fichiers (aperçu, fichiers modifiés)
  et Consommation (dont « tokens évités », estimation avec sa méthode affichée).
- `@fichier` avec autocomplétion et avertissement de troncature ; commandes `/` (équivalents du CLI et
  commandes-prompts comme /review ou /fix) ; palette Ctrl+K ; aide F1 ; pièces jointes (bouton, glisser-déposer,
  collage d'une capture) ; export Markdown ; recherche dans le contenu des conversations.
- Diff global des fichiers modifiés depuis le début de la conversation et « Tout annuler » (confirmation),
  y compris dans les dossiers sans Git (dépôt fantôme dans les données d'Eclipse).
- Fiabilité : écran de démarrage, bannière et « Relancer le moteur » si le moteur tombe, journaux avec rotation
  (« Ouvrir les logs »), tests de bout en bout de l'interface avant chaque compilation.
### Agents et mémoire
- Tous les fournisseurs reçoivent le guide d'économie de tokens d'Eclipse (mémoire, lecture par plages, compactage).
- OpenCode : lancé en `--standalone` dans le bon dossier (il travaillait auparavant dans le dossier du service
  OpenCode en arrière-plan) et branché sur la mémoire d'Eclipse par MCP (vérifié avec un modèle gratuit).
- Mémoire : doublons exacts refusés, notes modifiables avec historique, notes épinglées toujours fournies à l'IA.
### Sécurité
- Commandes toujours refusées, quel que soit le mode (formatage de disque, suppression du système ou du dossier
  personnel, écriture directe sur un disque, arrêt de l'ordinateur…).
- CSP stricte dans l'application et désormais aussi en mode navigateur ; contrastes WCAG AA.
### Applications et distribution
- Paquets Linux AppImage, .deb, .rpm ; Windows : installateur NSIS, MSI et version portable.
- Mises à jour depuis GitHub, canaux stable et bêta. Avant d'installer : journal des changements affiché,
  empreinte SHA-256 contrôlée et signature vérifiée (liée au numéro de version). Toute vérification qui échoue entraîne un refus.
- Script d'installation Linux (`install.sh`) : vérifie la signature et l'empreinte avant d'installer.
- Application Android (Kotlin) : terminal SSH vers vos machines et Eclipse distant ; secrets chiffrés par l'Android
  Keystore, empreinte des serveurs vérifiée, permission Internet uniquement, mises à jour hors Play Store.
### Sécurité
- Clés d'API uniquement dans le trousseau du système (Secret Service/KWallet, Gestionnaire d'identification Windows) :
  plus aucun repli en clair. Un ancien `credentials.json` est transféré dans le trousseau puis supprimé.
- Audit automatique des dépendances dans la CI (OSV, pip-audit, npm audit) ; bilan dans docs/SECURITE.md.
### Moteur
- Commandes de l'IA sous Windows : PowerShell (commande encodée, accents et guillemets préservés), cmd en UTF-8 ou WSL ;
  le modèle est informé de la syntaxe à utiliser.
- Fins de ligne conservées : un fichier CRLF reste en CRLF, un fichier LF reste en LF (Linux comme Windows).
- Claude Code, OpenCode et Codex installés par npm sous Windows : lancés directement par node (arguments intacts).

## 0.2.0 — 2026-11-13
### Interface (refonte)
- Barre d'état en haut : projet, branche Git, fournisseur et modèle, mode, bypass, jauge de contexte, consommation de la session.
- Saisie **multiligne** (Entrée envoie, Maj+Entrée / Ctrl+J / Alt+Entrée nouvelle ligne), **historique** (↑/↓ en bord), estimation des tokens pendant la frappe.
- Indicateur d'activité animé (réflexion, outil en cours, durée, Échap).
- **Pied de tour** : durée, tokens (mesurés/estimés), points ou USD estimés.
- Carte d'accueil, barre latérale à **onglets** (Session · Conso · Outils), blocs d'outils **repliables d'un clic** (lectures repliées, erreurs toujours dépliées), résumés d'outils lisibles.
- **Diffs toujours affichés** quand une modification est appliquée (même en mode « modifications auto » ou bypass).
- Notifications brèves pour les réglages (au lieu d'encombrer la conversation) ; signal sonore / notification bureau en fin de tour long.

- **Aucun emoji** : icônes **Nerd Fonts** officielles (Material Design, Devicons, Codicons — liste nerdfonts.com 3.5.1), détectées automatiquement ;
  repli sur des symboles texte simples sans police Nerd Font (`/config` → `icons` = auto | nerd | text).
- **Consommation réorganisée** en cadres titrés et séparés : Fournisseur → Abonnement (une partie par fenêtre 5 h / 7 j : utilisé, écoulé, rythme,
  renouvellement) → Cette session → Budget → Totaux locaux, libellés alignés, nature de chaque valeur indiquée.
- **Abonnements** (Claude Code, Codex, Kiro, OpenCode…) : c'est l'abonnement qui gère la consommation — `/define-token`, `/rate` et `/spent` ne sont plus
  proposés et aucun budget en points n'est affiché ; seule une limite `/limit` propre à Eclipse reste possible (et s'affiche si elle existe).

### Fonctions
- **Modèles gratuits** (`/free`, `eclipse free`) : OpenCode sans compte (mode délégué), OpenRouter `:free`, Ollama local (démarrage et téléchargement guidés), offres gratuites par clé ; `/models free`.
- **Images jointes** (`@image.png`, `/attach`) : modèles multimodaux par API, Claude Code (entrée stream-json), OpenCode (`--file`).
- Outil **`web_fetch`** (lecture de pages web, confirmation, alerte sur les adresses locales/privées).
- **Paramètres d'échantillonnage** standard (temperature, top_p, seed, top_k, pénalités) selon le catalogue de chaque modèle (`/options`).
- `/retry` (`/regenerate`), `/edit`, `/fork`, suppression de session (Ctrl+D dans `/sessions`), `/add-dir`, `/system` (consignes personnelles globales et du projet), `/config` (tous les réglages), `/doctor`, `/context`, `/diff`, `/attach`, `/login`, `/logout`.
- Commandes-prompts intégrées : `/review`, `/explain`, `/tests`, `/fix`, `/commit`, `/plan` (remplaçables par vos commandes personnalisées).
- Préréglages Cerebras et GitHub Models ; modalités d'entrée et gratuité lues dans les catalogues (Poe, OpenRouter, OpenCode Zen).
- Sous-commandes `eclipse free`, `eclipse doctor`.

### Corrections
- Ouvrir ou reprendre une session dont le dossier n'existe plus affiche un message clair au lieu de planter.

## 0.1.0 — 2026-11-09 → 11-10
Première version : agent à outils natifs, Neural Memory Engine, budgets locaux, MCP, mode Claude Code, commandes OpenCode, skills/plugins/modes, fournisseurs par clé, agents délégués, barres de progression, `/usage`, `/effort`, bypass, mode fusion.
