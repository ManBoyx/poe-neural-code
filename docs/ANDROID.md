# Eclipse pour Android

## Ce que fait l'application
- **Terminal SSH** vers vos machines : clé Ed25519 propre à l'application, clé importée, ou mot de passe.
- **Accès aux IA par votre PC :** la commande de démarrage `ECLIPSE_ICONS=nerd eclipse` ouvre Eclipse sur le PC,
  avec ses agents, ses budgets et sa mémoire. Le téléphone n'affiche que le terminal et ne stocke **aucune clé d'IA**.
  Pour y accéder hors de chez vous, rendez le PC joignable par Tailscale ou WireGuard, sans ouvrir le port 22 sur Internet.
- **Rangée de touches** : Échap, Tab, Ctrl+C, Ctrl+X (leader d'Eclipse), Ctrl+T, Ctrl+P, Ctrl+D, flèches.
- **Police JetBrainsMono Nerd Font** embarquée : les icônes d'Eclipse s'affichent.

Techniquement, c'est du Kotlin natif avec Jetpack Compose, et deux bibliothèques sous licence Apache-2.0, compatibles
avec la licence propriétaire : le terminal est `org.connectbot:termlib` (celui de ConnectBot), le SSH est `sshj` avec BouncyCastle.

## Sécurité
| Point | Choix |
|---|---|
| Permissions | **Internet uniquement** |
| Secrets (clé privée, mots de passe, clés importées) | chiffrés en AES-256-GCM. La clé de chiffrement est dans l'**Android Keystore** (matériel sécurisé si le téléphone en a un), non exportable |
| Sauvegardes | désactivées (`allowBackup=false`, règles d'extraction vides) : les secrets ne partent ni dans le cloud ni vers un autre appareil |
| Clé du serveur | montrée et confirmée à la première connexion, puis vérifiée à chaque fois. Si elle change, la connexion est **refusée** |
| Télémétrie | aucune. Seule la vérification des mises à jour contacte GitHub ; elle se désactive dans les réglages |
| Trafic en clair | interdit (`usesCleartextTraffic=false`) |

## Mises à jour (hors Play Store)
L'application lit les versions publiées sur `ManBoyx/eclipse-releases` : au démarrage, ou par « Vérifier maintenant ».
Canaux disponibles : stable ou bêta. Elle affiche le journal des changements et l'empreinte SHA-256, puis ouvre le
téléchargement de l'APK dans le navigateur. **Android refuse d'installer la mise à jour si elle n'est pas signée avec
la même clé** que l'application installée : c'est la garantie d'authenticité. Aucune permission « installer des
applications » n'est demandée par Eclipse.

## Signer l'APK avec VOTRE clé (une seule fois)
Ne collez jamais le keystore ni ses mots de passe dans un chat ou un fichier du dépôt.

1. **Générer le keystore sur votre machine.** keytool est fourni avec le JDK, et le JDK 21 est déjà téléchargé dans
   `build/cache/jdk21` :
   ```
   ~/Projets/poe-neural-code/build/cache/jdk21/bin/keytool -genkeypair -v -keystore ~/eclipse-release.jks \
     -alias eclipse -keyalg RSA -keysize 4096 -validity 10000
   ```
   keytool demande un mot de passe pour le keystore et votre nom (il peut être fictif).
2. **Sauvegarder `eclipse-release.jks` et ses mots de passe hors de l'ordinateur.** Si vous les perdez, vous ne pourrez
   plus publier de mise à jour installable par-dessus les versions existantes : les utilisateurs devraient désinstaller,
   puis réinstaller.
3. **Secrets GitHub** du dépôt de code (Settings > Secrets and variables > Actions) :
   - `ANDROID_KEYSTORE_BASE64` : le résultat de `base64 -w0 ~/eclipse-release.jks` ;
   - `ANDROID_KEYSTORE_PASSWORD` : le mot de passe du keystore ;
   - `ANDROID_KEY_ALIAS` : `eclipse` ;
   - `ANDROID_KEY_PASSWORD` : le mot de passe de la clé (souvent le même).

La CI décode le keystore dans un dossier temporaire, signe l'APK, l'efface aussitôt, puis vérifie la signature
(`apksigner verify`).

## Si vous voulez la mettre sur le Play Store plus tard
- **Compte développeur Google Play :** 25 $, une seule fois, avec vérification d'identité.
- **Compte personnel récent :** test fermé obligatoire avec au moins 12 testeurs pendant 14 jours avant la publication.
- **Format :** Android App Bundle (`.aab`, `./gradlew bundleRelease`), plutôt que l'APK.
- **Signature :** « Play App Signing ». Google conserve la clé de signature et vous gardez une clé d'envoi. On peut
  confier à Google la clé actuelle, pour que les APK du site et ceux du Play Store restent compatibles.
- **Niveau d'API cible :** récent (Google relève le minimum chaque année ; Eclipse cible 36).
- **Fiche :** politique de confidentialité publiée (une page suffit : « aucune donnée collectée »), formulaire
  « Sécurité des données », classification du contenu, captures d'écran.
- **Mises à jour :** la vérification GitHub doit être désactivée dans la version Play Store, qui se met à jour par le
  Play Store. Eclipse ne demande pas la permission d'installer des paquets, ce qui évite un refus.

## Tests effectués
- **Tests JVM (12) :**
  - un vrai serveur SSH (Apache MINA) : clé de l'application, mot de passe, empreinte mémorisée, empreinte changée
    refusée, envois simultanés ;
  - stockage chiffré : aucun secret en clair sur le disque ;
  - versions et canaux de mise à jour.
- **Émulateur Android 15, APK release minifié :**
  - ajout d'un serveur ;
  - première connexion : empreinte identique à celle donnée par `ssh-keygen -lf` sur le serveur ;
  - commande de démarrage, accents ;
  - **vrai moteur Eclipse** affiché par SSH ;
  - reconnexion sans nouvelle question.
- **Pas encore testé :**
  - un vrai téléphone ;
  - clavier matériel et claviers non latins ;
  - Android 8 à 11 (version minimale 8.0) ;
  - la mise à jour par-dessus une version signée avec votre clé.
