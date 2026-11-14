# À tester sur un vrai Windows

Ce qui ne peut pas être vérifié depuis Linux. La CI (GitHub Actions, `windows-latest`) construit l'installateur et
lance les tests Python du moteur sous Windows ; tout ce qui demande un écran, un clavier ou une installation
réelle reste à faire à la main, sur Windows 10 (version 1809 ou plus récente) et Windows 11.

## Installation
- [ ] Installateur NSIS (`Eclipse_x.y.z_x64-setup.exe`) : installe sans droits administrateur (mode « utilisateur courant »).
- [ ] Avertissement SmartScreen attendu (pas de certificat de signature) : « Informations complémentaires » puis « Exécuter quand même ».
- [ ] Installateur MSI : installe et se désinstalle depuis « Applications installées ».
- [ ] Machine sans WebView2 (Windows 10 ancien) : l'installateur télécharge WebView2.
- [ ] Version portable (.zip) : décompressée dans un dossier quelconque, elle démarre et crée `data\` à côté de l'exécutable.

## Terminal (ConPTY)
- [ ] L'onglet Eclipse démarre et affiche les icônes (police embarquée), sans caractères carrés.
- [ ] Onglets PowerShell 7, Windows PowerShell, cmd, WSL et Git Bash (si installés) : chacun s'ouvre, l'invite s'affiche.
- [ ] Accents : `echo élève` dans cmd, `Write-Output "élève"` dans PowerShell, `dir` d'un dossier « Été » : rien de cassé.
- [ ] Redimensionner la fenêtre : le texte se réorganise (Eclipse comme les shells), pas de lignes dupliquées.
- [ ] Fermer un onglet ou la fenêtre : aucun `eclipse-engine.exe`, `pwsh.exe` ou `conhost.exe` ne reste dans le Gestionnaire des tâches.
- [ ] `exit` dans un shell : le message « Session terminée » apparaît, « Relancer » fonctionne.

## Clavier et presse-papiers
- [ ] Ctrl+C sans sélection interrompt (`ping -t localhost` dans cmd) ; avec sélection, copie.
- [ ] Ctrl+V colle ; Ctrl+Maj+C / Ctrl+Maj+V aussi ; clic droit copie (sélection) ou colle.
- [ ] Coller plusieurs lignes dans PowerShell : pas d'exécution ligne par ligne non voulue (collage « bracketed »).
- [ ] Raccourcis Eclipse : Ctrl+X puis une lettre (leader), Ctrl+T, Ctrl+P, F2, Tab, Échap, Ctrl+R (renommer, pas de rechargement de la page).
- [ ] F5 et Ctrl+R ne rechargent pas l'interface.
- [ ] AltGr (claviers AZERTY) : `@`, `#`, `{`, `}`, `[`, `]`, `\`, `|`, `~` se tapent normalement.

## Moteur Eclipse sous Windows
- [ ] `run_command` utilise PowerShell 7 (ou Windows PowerShell) ; `/config shell = cmd` ou `wsl` change de shell.
- [ ] Le modèle reçoit bien la consigne « syntaxe PowerShell » (il ne propose plus de commandes bash).
- [ ] Mode Claude Code : `claude` installé par npm (`claude.cmd`) ou par l'installateur natif (`claude.exe`) démarre, les prompts avec guillemets et accents arrivent intacts.
- [ ] OpenCode / Codex installés par npm : même vérification.
- [ ] Écriture d'un fichier CRLF existant : il reste en CRLF ; nouveau fichier : LF (réglable avec `new_file_eol`).
- [ ] `/undo` : fonctionne si Git pour Windows est installé ; message clair sinon.
- [ ] Interruption (Échap) d'une commande longue : tout l'arbre de processus est arrêté (`taskkill /T`).
- [ ] Clés d'API : stockées dans le Gestionnaire d'identification Windows (étape 6), visibles sous « Informations d'identification Windows ».

## Mises à jour (après l'étape 3)
- [ ] Installation NSIS : la mise à jour se télécharge, sa signature est vérifiée, l'installateur se relance seul.
- [ ] Version portable : l'application propose le téléchargement du nouveau .zip (pas d'installation automatique).
