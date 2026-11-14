# Sécurité

## Signaler une faille
Ne publiez pas de ticket public. Utilisez le signalement privé de GitHub :
https://github.com/ManBoyx/eclipse-releases/security/advisories/new

Indiquez la version d'Eclipse, le système, les étapes pour reproduire et l'impact. Un premier retour est envoyé sous 7 jours.

## Versions suivies
Seule la dernière version stable reçoit des correctifs de sécurité.

## Ce que l'application garantit
- **Secrets :** les clés d'API, clés SSH et jetons sont stockés dans le trousseau du système (libsecret sous Linux,
  Gestionnaire d'identification sous Windows, Android Keystore). Jamais en clair, jamais dans les journaux.
- **Télémétrie :** aucune. La seule connexion qu'Eclipse fait de lui-même est la vérification des mises à jour
  sur GitHub. Elle se désactive dans les réglages.
- **Mises à jour :** refusées si l'empreinte SHA-256 ou la signature (liée au numéro de version) ne correspond pas.
- **Commandes lancées par l'IA :** confirmation demandée, élévation de privilèges (sudo, runas) toujours refusée,
  aucune isolation (elles s'exécutent avec vos droits : voir docs/LIMITES.md).
