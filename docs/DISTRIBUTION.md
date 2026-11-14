# Distribution

## Deux dépôts
| Dépôt | Visibilité | Contenu |
|---|---|---|
| `ManBoyx/poe-neural-code` | privé | code, CI, publication |
| `ManBoyx/eclipse-releases` | **public** | README d'installation, LICENSE, CHANGELOG, SECURITY, `bucket/` (Scoop), Releases (binaires, `latest.json`, `SHA256SUMS`, signatures) |

À chaque tag `vX.Y.Z`, la CI du dépôt privé :
1. construit et signe les paquets ;
2. crée la release dans le dépôt public ;
3. met à jour le manifeste du canal bêta ;
4. pour une version stable seulement, met à jour le README, le CHANGELOG et le manifeste Scoop du dépôt public.

## Secrets GitHub Actions (dépôt privé)
| Secret | Rôle | Qui le crée |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | signature des mises à jour et de SHA256SUMS | vous (docs/MISES-A-JOUR.md) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | mot de passe de cette clé | vous |
| `RELEASES_TOKEN` | publier dans `eclipse-releases` | vous (voir ci-dessous) |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | signature de l'APK | vous (docs/ANDROID.md) |

`RELEASES_TOKEN` se crée dans GitHub > Settings > Developer settings > Fine-grained tokens, avec ces réglages :
- **Repository access :** `ManBoyx/eclipse-releases` uniquement ;
- **Permissions :** Contents en lecture et écriture ;
- **Expiration :** 1 an (pensez à le renouveler).

## Coût des GitHub Actions (dépôt privé, offre gratuite : 2 000 minutes/mois)
Les minutes Windows comptent double. Ordres de grandeur, à confirmer sur les premiers lancements :
- **une publication complète :** environ 60 à 80 minutes décomptées (Linux 15, Windows 20 × 2, Android 10, publication 2) ;
- **un envoi de code (CI) :** environ 20 minutes (tests Linux 3, tests Windows 5 × 2, Rust 8).

Les tests restent dans le dépôt privé : ils ne sont pas gratuits, contrairement à un dépôt public.

## winget (gratuit)
La première soumission se fait à la main, depuis un Windows et une fois une version stable publiée :
```powershell
winget install wingetcreate
wingetcreate new https://github.com/ManBoyx/eclipse-releases/releases/download/vX.Y.Z/Eclipse_X.Y.Z_x64-setup.exe
```
L'identifiant à indiquer est `ManBoyx.Eclipse`. `wingetcreate` ouvre une demande de fusion dans `microsoft/winget-pkgs`,
que Microsoft valide (analyse antivirus et installation automatique). Les installateurs non signés sont acceptés.
Les versions suivantes peuvent être soumises automatiquement (action `vedantmgoyal9/winget-releaser`, avec un jeton
personnel `public_repo`). Elle n'est pas activée tant que la première version n'a pas été acceptée.

## Scoop (gratuit)
Le dépôt public sert aussi de « bucket » : `bucket/eclipse.json` est régénéré à chaque version stable.
Il pointe vers la version portable, dont l'empreinte SHA-256 est vérifiée par Scoop.

## Windows SmartScreen et signature de code
Sans certificat de signature de code, SmartScreen avertit au premier lancement. Cet avertissement s'estompe à mesure
qu'un même fichier est téléchargé (réputation). Options :

| Option | Coût | Limite |
|---|---|---|
| SignPath Foundation | gratuit | **réservé aux projets open source** (licence OSI, code public) : incompatible avec la licence propriétaire choisie |
| Azure Trusted Signing (Artifact Signing) | environ 10 $/mois | conditions d'éligibilité (ancienneté de l'entreprise, ou particuliers selon les pays) à vérifier au moment de l'inscription |
| Certificat OV classique (Sectigo, SSL.com…) | environ 200 à 400 $/an | clé sur jeton matériel ou HSM cloud ; ne supprime pas l'avertissement tant que la réputation n'est pas établie |
| Ne pas signer | 0 | avertissement SmartScreen ; documenté dans le README avec la vérification SHA-256 |
