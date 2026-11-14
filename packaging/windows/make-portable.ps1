# Version portable Windows : un .zip à décompresser n'importe où, sans installation ni droits administrateur.
# Contenu : eclipse-terminal.exe + moteur (engine\) + portable.txt (les données restent dans .\data).
# Prérequis sur la machine cible : WebView2 (présent d'office sous Windows 11 et sur Windows 10 à jour).
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Target = "build/cache/target/release",
  [string]$Engine = "build/engine/dist/eclipse-engine",
  [string]$Out = "build/portable"
)
$ErrorActionPreference = "Stop"
$name = "Eclipse_${Version}_x64_portable"
$dir = Join-Path $Out $name
if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item (Join-Path $Target "eclipse-terminal.exe") $dir
Copy-Item -Recurse $Engine (Join-Path $dir "engine")
Copy-Item LICENSE $dir
Set-Content -Encoding utf8 -Path (Join-Path $dir "portable.txt") -Value "Mode portable : les données d'Eclipse sont enregistrées dans le dossier data à côté de ce fichier."
$zip = Join-Path $Out "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $dir -DestinationPath $zip
Write-Host "Archive portable : $zip"
