# Sécurité d'Eclipse (bilan de l'étape 6, 14/11/2026)

## Où sont les secrets
| Secret | Linux | Windows | Android |
|---|---|---|---|
| Clés d'API des IA | trousseau (Secret Service : GNOME Keyring ou KWallet) | Gestionnaire d'identification | — (aucune clé d'IA sur le téléphone : Eclipse tourne sur le PC) |
| Clés SSH, mots de passe SSH | — (ceux d'OpenSSH, gérés par le système) | — | AES-256-GCM avec une clé de l'**Android Keystore**, sauvegardes désactivées |
| Clé de signature des mises à jour | secrets GitHub Actions uniquement | idem | keystore APK : secrets GitHub Actions uniquement |

- **Jamais en clair :** si aucun trousseau sécurisé n'est disponible (serveur sans session graphique, trousseau
  « fichier » de `keyrings.alt`…), Eclipse **refuse d'enregistrer** la clé et indique la variable d'environnement à
  utiliser. L'ancien repli `credentials.json` (non chiffré) est supprimé : un tel fichier existant est transféré dans
  le trousseau, puis effacé.
- **Jamais dans les journaux :** `pnc.log` masque les motifs de clés (`sk-…`, `ghp_…`, `Bearer …`, `api_key=…`) et la
  valeur de `POE_API_KEY`. Les clés saisies sont masquées à l'écran et ne sont jamais affichées en entier (`mask`).
- **Jamais transmises aux programmes lancés :** `POE_API_KEY` est retirée de l'environnement des commandes et agents.
- **Jamais dans le dépôt :** `.gitignore` exclut `*.jks`, `*.keystore` et `local.properties`. Les tests utilisent un
  trousseau factice en mémoire et des clés jetables. Les champs de clé publique sont laissés vides, pour que vous
  les remplissiez vous-même.
- **Fichier temporaire :** en mode Claude Code, un jeton aléatoire, valable une seule session, protège le pont MCP local.
  Il est écrit avec les droits 600 sous Linux ; sous Windows, il est dans le dossier temporaire de l'utilisateur,
  dont les droits sont propres à l'utilisateur.

## Télémétrie et connexions sortantes
Il n'y a **aucune télémétrie** : ni statistiques, ni rapports de plantage, ni identifiant. Ce qui sort de la machine :

| Composant | Destination | Quand | Désactivable |
|---|---|---|---|
| Moteur | le fournisseur d'IA que vous avez connecté (Poe, OpenAI, OpenRouter…) | à chaque requête | oui, ne pas le connecter |
| Moteur | page web demandée par l'outil `web_fetch` | sur confirmation | oui, refuser |
| Desktop | `github.com/ManBoyx/eclipse-releases` (manifeste de mise à jour) | au démarrage puis toutes les 1, 6 ou 24 h | **oui**, Réglages |
| Android | `api.github.com` (dernière version) | au démarrage | **oui**, Réglages |
| Android | vos serveurs SSH | quand vous vous connectez | — |

La bibliothèque `mcp` dépend de `opentelemetry-api`. Sans module d'export installé, cette API ne fait rien et n'envoie aucune donnée.

## Audit des dépendances
| Écosystème | Outil | Résultat |
|---|---|---|
| Python (moteur, 47 paquets installés) | pip-audit | **0 faille** dans les dépendances d'exécution. 8 avis concernaient `pip` 26.0.1 (outil de développement, non livré dans le moteur) : mis à jour en 26.3 |
| npm (interface desktop, 90 paquets) | npm audit + OSV | **0** |
| Rust (application desktop, 563 crates) | OSV (RustSec) | **0 faille exploitable**. 5 avis acceptés, voir ci-dessous |
| Android (136 bibliothèques d'exécution) | OSV (Maven) | **0** |

Avis Rust acceptés. Ils sont justifiés et datés dans `osv-scanner.toml`, et redeviennent bloquants le 01/05/2027 :
- `RUSTSEC-2024-0429` (glib 0.18) : défaut de solidité dans `glib::VariantStrIter`. Eclipse ne s'en sert pas ;
  cette version est imposée par Tauri sous Linux, et le problème disparaîtra quand Tauri passera à gtk-rs 0.20.
- `RUSTSEC-2024-0370` (proc-macro-error), `RUSTSEC-2026-0370/0371/0372` (zvariant, zbus_names, zvariant_derive) :
  bibliothèques **non maintenues**, sans faille connue.

La CI refait cet audit à chaque envoi (`osv-scanner`, `pip-audit`, `npm audit`) : tout nouvel avis la fait échouer.
Dependabot propose chaque semaine les mises à jour de sécurité.

## Windows sans certificat de signature de code
SmartScreen avertit au premier lancement : « Informations complémentaires » puis « Exécuter quand même ».
Options et coûts : voir `docs/DISTRIBUTION.md`. En résumé :
- **SignPath Foundation (gratuit) est réservé à l'open source** : incompatible avec la licence propriétaire choisie ;
- Azure Trusted Signing coûte environ 10 $/mois, sous conditions d'éligibilité ;
- un certificat OV coûte 200 à 400 $/an et n'efface pas l'avertissement tant que la réputation n'est pas établie.

Ce qui reste vérifiable gratuitement :
- les mises à jour automatiques sont signées (minisign) ;
- `SHA256SUMS` est publié et signé ;
- le README explique comment vérifier un téléchargement.

## Limites connues
- Les commandes lancées par l'IA ne sont **pas isolées** (pas de bac à sable). Il y a une confirmation, et
  l'élévation de privilèges (sudo, runas) est toujours refusée ; voir `docs/LIMITES.md`.
- L'application Android ne bloque pas les captures d'écran (`FLAG_SECURE` non activé) : le terminal peut afficher
  des informations sensibles. C'est activable si vous le souhaitez.
- La signature de `SHA256SUMS` n'est vérifiée par `install.sh` que si `minisign` est installé. Sinon, seule
  l'empreinte est contrôlée (intégrité, mais pas authenticité), et le script le dit.
