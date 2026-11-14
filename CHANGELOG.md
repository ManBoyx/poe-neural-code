# Journal des versions

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
