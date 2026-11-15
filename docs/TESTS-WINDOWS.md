# Tests à faire sur Windows (Eclipse Desktop 0.3.0)

Machines visées : Windows 10 (version 1809 ou plus récente) et Windows 11. Pour chaque ligne, notez OK / KO et,
en cas de KO, joignez le dossier des logs (Réglages > Ouvrir les logs).

## 1. Installation
1. Installateur `Eclipse_0.3.0_x64-setup.exe` : l'installation se fait sans demande de droits administrateur.
2. SmartScreen s'affiche (binaire non signé) : « Informations complémentaires » puis « Exécuter quand même » permet de continuer.
3. `Eclipse_0.3.0_x64_fr-FR.msi` : installe, puis se désinstalle depuis Paramètres > Applications.
4. Sur une machine sans WebView2, l'installateur le télécharge et l'application démarre ensuite.
5. Le raccourci « Eclipse » du menu Démarrer lance l'application.

## 2. Démarrage et moteur
1. Au premier lancement, l'écran « Démarrage du moteur Eclipse… » s'affiche, puis l'accueil, en moins de 60 s.
   Notez la durée (un antivirus peut ralentir la première fois).
2. Aucune fenêtre de console noire ne s'ouvre à côté de l'application.
3. Le Gestionnaire des tâches montre `eclipse-terminal.exe` et `eclipse-engine.exe`.
   Après fermeture de la fenêtre, ni l'un ni l'autre ne reste au bout de 5 s.
4. Tuer `eclipse-engine.exe` depuis le Gestionnaire des tâches : la bannière « Le moteur Eclipse ne répond plus »
   apparaît en moins de 20 s. « Relancer le moteur » ramène l'interface sans fermer la fenêtre.
5. Réglages > « Ouvrir les logs » ouvre l'Explorateur sur `%APPDATA%\poe-neural-code\logs`, qui contient `pnc.log`,
   `ui.log` et `engine-stderr.log`.

## 3. Discussion et fichiers
1. « Nouvelle discussion » crée `%USERPROFILE%\Projets\Eclipse\discussion-AAAAMMJJ-HHMMSS` et l'ouvre.
2. « Ouvrir un projet… » ouvre la boîte de dialogue native de choix de dossier, et le projet choisi s'ouvre.
3. Connexions > Claude Code (si installé par npm ou par l'installateur officiel) : un message simple reçoit une réponse.
4. Demander à l'IA de créer `test.txt` avec « élève » : la carte d'autorisation s'affiche. Après accord, le fichier
   existe et s'ouvre correctement dans le Bloc-notes, avec les accents intacts.
5. Demander une commande (par exemple « liste les fichiers ») : elle s'exécute dans PowerShell, avec une syntaxe
   PowerShell. Les accents de la sortie sont corrects dans la carte d'outil.
6. Un fichier existant en fins de ligne CRLF, modifié par l'IA, reste en CRLF (vérifier dans Notepad++ ou VS Code).
7. Panneau Fichiers : `test.txt` apparaît comme modifié, et l'aperçu s'ouvre.
8. `/diff` (ou palette > « Modifications des fichiers ») : le diff s'affiche. « Tout annuler » supprime `test.txt`
   après confirmation.
9. `@` dans la saisie : l'autocomplétion propose les fichiers du dossier ; un chemin avec sous-dossier s'insère bien.
10. Glisser une image depuis l'Explorateur dans la fenêtre : la pièce jointe apparaît. Coller une capture
    (Win+Maj+S puis Ctrl+V) : idem.
11. `/export` : la boîte « Enregistrer sous » native s'ouvre et le fichier `.md` est écrit à l'endroit choisi.

## 4. Clavier et affichage
1. Ctrl+K (palette), Ctrl+N (nouvelle discussion), Ctrl+B (barre latérale), Ctrl+, (réglages), Échap (arrêter une réponse).
2. Clavier AZERTY : `@`, `#`, `{`, `}`, `[`, `]`, `\`, `|`, `~` se tapent normalement dans la saisie.
3. Thème clair et thème sombre lisibles. Avec la mise à l'échelle Windows à 125 % et 150 %, le texte est net
   et rien ne déborde.
4. Les icônes (police Nerd Font embarquée) s'affichent : aucun carré vide.

## 5. Sécurité et clés
1. Connexions > une clé d'API : elle apparaît dans Gestionnaire d'identification > Informations d'identification Windows
   (nom `eclipse-poe-neural-code`) et n'est écrite nulle part en clair dans `%APPDATA%\poe-neural-code`.
2. Demander à l'IA une commande `Format-Volume` ou `rm -rf /` : elle est refusée sans même proposer d'autorisation (étape E).

## 6. Version portable
1. Décompresser `Eclipse_0.3.0_x64_portable.zip` dans un dossier quelconque (ou une clé USB) et lancer `eclipse-terminal.exe`.
2. Après une discussion, un dossier `data\` existe à côté de l'exécutable, avec `logs\`, `sessions\` et `memory.db`.
   `%APPDATA%\poe-neural-code` n'est pas modifié.
3. Les mises à jour proposent « Page de la version » ; « Installer » est indisponible, avec l'explication.

## 7. Mise à jour 0.2.x vers 0.3.0 (nécessite vos clés et une version publiée)
1. Installer une 0.2.x signée avec votre clé, puis publier la 0.3.0 (ou une 0.3.0-beta.1 sur le canal bêta).
2. Réglages > « Vérifier maintenant » : le bouton « Mise à jour 0.3.0 » apparaît. Le journal des changements s'affiche
   avant l'installation.
3. « Installer » : téléchargement, vérification, puis l'installateur se lance en mode passif et Eclipse redémarre en 0.3.0
   (Réglages affiche 0.3.0).
4. Remplacer le fichier téléchargé par un autre (test avancé, facultatif) : la mise à jour est refusée.
