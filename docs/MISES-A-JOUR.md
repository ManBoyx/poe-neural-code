# Mises à jour d'Eclipse

## Ce que fait l'application

1. **Quand :** 15 s après le démarrage, puis toutes les 1, 6 ou 24 h (6 h par défaut). Tout est réglable dans Réglages,
   et la vérification automatique peut être désactivée. Le bouton « Vérifier maintenant » reste disponible.
2. **Canal :**
   - **Stable** lit `releases/latest/download/latest.json`. GitHub exclut les préversions de ce lien.
   - **Bêta** lit la release permanente `beta-channel`, que la CI met à jour à chaque version, stable ou bêta.
     Un utilisateur du canal bêta reçoit donc toujours la version la plus récente.
3. **Journal des changements :** si une version plus récente existe, un bouton « Mise à jour x.y.z » apparaît.
   Il ouvre le journal des changements, tiré de la section correspondante de `CHANGELOG.md`.
   Rien ne s'installe sans un clic sur « Installer ».
4. **Installation, avec trois contrôles dans cet ordre.** Si l'un échoue, la mise à jour est refusée et rien n'est installé.
   - Le manifeste est lu en HTTPS depuis github.com.
   - **SHA-256 :** l'empreinte du fichier téléchargé doit être égale à celle du manifeste. Une empreinte absente entraîne aussi un refus.
   - **Signature minisign :** elle est vérifiée avec la clé publique intégrée à l'application. Elle doit aussi porter
     le **même numéro de version** que celui annoncé (`requireSignedVersion`), ce qui empêche de faire passer un ancien
     paquet signé pour une nouvelle version.
5. **Selon le format installé :**

| Format installé | Mise à jour |
|---|---|
| AppImage | remplacée sur place, puis redémarrage |
| .deb / .rpm | `dpkg -i` / `rpm -U` via pkexec (votre mot de passe administrateur est demandé) |
| Windows NSIS / MSI | l'installateur se lance en mode « passif » puis relance Eclipse |
| Windows portable (.zip) | pas d'installation automatique : lien vers la page de la version |

Une application compilée **sans clé publique** refuse toute mise à jour. La compilation officielle échoue elle aussi
sans clé privée : on ne peut pas publier de mise à jour non signée par erreur.

Testé ici avec des clés jetables (`desktop/src-tauri/src/updates.rs`, test `signature_chain_with_throwaway_keys`).
Un paquet intact est accepté. Il est refusé dans trois cas : un seul octet modifié, une signature faite avec une autre
clé, ou une signature valide présentée sous un autre numéro de version.

## Ce que vous devez faire (une seule fois)

Ne collez jamais la clé privée ni son mot de passe dans un chat, un ticket ou un fichier du dépôt.

1. **Générer la paire de clés sur votre machine** :
   ```
   cd ~/Projets/poe-neural-code/desktop
   npx tauri signer generate -w ~/.tauri/eclipse-updater.key
   ```
   Choisissez un mot de passe solide quand il est demandé. Deux fichiers sont créés :
   `eclipse-updater.key` (privée) et `eclipse-updater.key.pub` (publique).
2. **Sauvegarder la clé privée hors de l'ordinateur** (gestionnaire de mots de passe, clé USB chiffrée).
   **Si vous la perdez, les installations existantes ne pourront plus jamais être mises à jour automatiquement.**
3. **Clé publique (elle n'est pas secrète) :** copiez le contenu de `eclipse-updater.key.pub` dans
   `desktop/src-tauri/tauri.conf.json`, champ `plugins.updater.pubkey` (laissé vide aujourd'hui).
4. **Secrets GitHub** du dépôt de code (Settings > Secrets and variables > Actions > New repository secret) :
   - `TAURI_SIGNING_PRIVATE_KEY` : tout le contenu du fichier `eclipse-updater.key` ;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : le mot de passe choisi à l'étape 1.

## Dépôt de code privé : dépôt public réservé aux releases

Si le dépôt du code reste privé, ses releases ne sont pas téléchargeables par vos utilisateurs.
La solution retenue est un dépôt **public** `ManBoyx/eclipse-releases` **sans aucun code source**. Il contient :
- un README avec les commandes d'installation, la LICENSE et le CHANGELOG ;
- dans ses Releases : les paquets, `latest.json`, `SHA256SUMS` et les signatures `.sig`.

La CI du dépôt privé y publie grâce à un jeton à portée réduite (secret `RELEASES_TOKEN`) :
- type : jeton « fine-grained » ;
- dépôt autorisé : `eclipse-releases` uniquement ;
- permission : Contents en lecture et écriture ;
- expiration : 1 an.

La création de ce dépôt se fait à l'étape 4, après votre accord.
