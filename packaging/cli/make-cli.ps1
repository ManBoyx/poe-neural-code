# Archive autonome du CLI Eclipse (Windows) à partir du moteur PyInstaller déjà construit. Aucun Python requis.
# Usage : ./packaging/cli/make-cli.ps1 -Version 0.3.0  → build/cli/eclipse-cli_0.3.0_windows-x64.zip
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Engine = "build/engine/dist/eclipse-engine"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path (Join-Path $Engine "eclipse-engine.exe"))) { throw "moteur absent : construire d'abord $Engine" }
$name = "eclipse-cli-$Version"
$dir = Join-Path "build/cli" $name
if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item -Recurse $Engine (Join-Path $dir "eclipse-engine")
# Lanceur : « eclipse » fonctionne dans cmd et PowerShell dès que le dossier est dans le PATH.
"@echo off`r`n`"%~dp0eclipse-engine\eclipse-engine.exe`" %*`r`n" | Set-Content -NoNewline -Encoding ascii (Join-Path $dir "eclipse.cmd")
@"
Eclipse $Version : CLI (interface terminal)

Lancer :         eclipse.cmd   (dans un dossier de projet ; Windows Terminal recommandé pour les icônes)
Installer :      ajouter ce dossier au PATH de l'utilisateur, puis taper « eclipse » dans un nouveau terminal
Interface web :  eclipse web   (même interface que l'application desktop, dans le navigateur)
Aide :           eclipse --help, puis /help dans l'application
Diagnostic :     eclipse doctor

Les données (sessions, mémoire, réglages) sont dans %APPDATA%\poe-neural-code.
Les clés d'API sont rangées dans le Gestionnaire d'identification Windows, jamais dans un fichier.
"@ | Set-Content -Encoding utf8 (Join-Path $dir "LISEZMOI.txt")
$zip = "build/cli/eclipse-cli_${Version}_windows-x64.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $dir -DestinationPath $zip
Write-Host "Archive CLI : $zip"
