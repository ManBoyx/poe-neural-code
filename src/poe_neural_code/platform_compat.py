"""Différences Linux / Windows regroupées ici : shell des commandes, lanceurs npm (.cmd), fins de ligne, groupes de processus.

Règle : le reste du code ne teste pas `sys.platform` lui-même, il passe par ces fonctions (testables en simulant la plateforme).
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SHELLS_POSIX = ("bash", "zsh", "sh")
SHELLS_WINDOWS = ("pwsh", "powershell", "cmd", "wsl")
SHELL_CHOICES = ("auto",) + SHELLS_POSIX + SHELLS_WINDOWS

# PowerShell écrit par défaut dans la page de code de la console : on force l'UTF-8 pour que les accents survivent.
_PS_UTF8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';"


def is_windows(platform: str | None = None) -> bool:
    return (platform or sys.platform) == "win32"


@dataclass(frozen=True)
class ShellSpec:
    name: str  # bash | zsh | sh | pwsh | powershell | cmd | wsl
    label: str  # texte montré à l'utilisateur et au modèle
    exe: str | None  # chemin trouvé (None : introuvable)

    @property
    def syntax(self) -> str:
        return {"pwsh": "PowerShell", "powershell": "Windows PowerShell 5.1", "cmd": "cmd.exe (batch)",
                "wsl": "bash (Linux, via WSL)"}.get(self.name, self.name)


def pick_shell(pref: str = "auto", platform: str | None = None, which=shutil.which) -> ShellSpec:
    """Choisit le shell de `run_command`. `auto` : bash puis sh (Linux) ; pwsh puis powershell (Windows)."""
    pref = (pref or "auto").lower()
    win = is_windows(platform)
    order = [pref] if pref != "auto" else (["pwsh", "powershell", "cmd"] if win else ["bash", "sh"])
    for name in order:
        exe = which({"cmd": "cmd.exe", "wsl": "wsl.exe"}.get(name, name) if win else name)
        if exe:
            label = {"pwsh": "PowerShell 7", "powershell": "Windows PowerShell", "cmd": "cmd", "wsl": "WSL"}.get(name, name)
            return ShellSpec(name, label, exe)
    # Rien trouvé : sous Windows cmd.exe existe toujours via COMSPEC, sous Linux /bin/sh.
    if win:
        return ShellSpec("cmd", "cmd", os.environ.get("COMSPEC", "cmd.exe"))
    return ShellSpec("sh", "sh", "/bin/sh")


def shell_invocation(command: str, spec: ShellSpec) -> tuple[list[str] | None, str | None]:
    """Retourne (argv, None) pour un lancement direct, ou (None, ligne) quand il faut passer par le shell système (cmd).

    PowerShell reçoit la commande en -EncodedCommand (UTF-16LE base64) : aucun problème de guillemets ni d'accents.
    cmd reçoit la ligne telle quelle (règles de cmd), précédée de `chcp 65001` pour l'UTF-8.
    """
    if spec.name in ("pwsh", "powershell"):
        enc = base64.b64encode((_PS_UTF8 + command).encode("utf-16-le")).decode("ascii")
        return [spec.exe or spec.name, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], None
    if spec.name == "cmd":
        return None, f"chcp 65001>nul & {command}"
    if spec.name == "wsl":
        return [spec.exe or "wsl.exe", "-e", "bash", "-lc", command], None
    return [spec.exe or spec.name, "-c", command], None


def environment_note(spec: ShellSpec, platform: str | None = None) -> str:
    """Phrase ajoutée au prompt système : le modèle doit écrire des commandes dans la bonne syntaxe."""
    osname = "Windows" if is_windows(platform) else ("macOS" if (platform or sys.platform) == "darwin" else "Linux")
    extra = ""
    if spec.name in ("pwsh", "powershell"):
        extra = " Use PowerShell syntax (Get-ChildItem, Select-String, $env:VAR, `;` to chain), not bash."
    elif spec.name == "cmd":
        extra = " Use cmd.exe syntax (dir, findstr, %VAR%, `&&` to chain), not bash."
    elif spec.name == "wsl":
        extra = " Commands run in bash inside WSL; Windows drives are under /mnt/c, /mnt/d…"
    return f"Operating system: {osname}. Shell used by run_command: {spec.syntax}.{extra}"


def group_kwargs(platform: str | None = None) -> dict:
    """Arguments Popen pour pouvoir tuer tout l'arbre de processus d'une commande."""
    if is_windows(platform):
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)}
    return {"start_new_session": True}


_SHIM_JS = re.compile(r'"?%~?dp0%?\\?([^"%\r\n]+?\.(?:c|m)?js)"', re.I)


def resolve_argv(argv: list[str], platform: str | None = None, which=shutil.which) -> list[str]:
    """Sous Windows, les CLI installées par npm (claude, opencode, codex…) sont des scripts `.cmd`.

    Passer de longs arguments (JSON, prompts) à travers cmd.exe les déforme ; on lit donc le script npm pour lancer
    directement `node <script.js>`. Un vrai .exe est lancé tel quel. Ailleurs qu'à Windows : inchangé.
    """
    if not argv or not is_windows(platform):
        return argv
    path = which(argv[0])
    if not path:
        return argv
    if not path.lower().endswith((".cmd", ".bat")):
        return [path, *argv[1:]]
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    m = _SHIM_JS.search(text)
    node = which("node")
    if m and node:
        script = (Path(path).parent / m.group(1).replace("\\", os.sep)).resolve()
        if script.is_file():
            return [node, str(script), *argv[1:]]
    # Dernier recours : passer par cmd.exe (les arguments simples restent corrects).
    return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", path, *argv[1:]]


# --- Fins de ligne ---------------------------------------------------------------------------------------------

def detect_eol(raw: str) -> str:
    """Fin de ligne dominante d'un texte lu avec newline='' (donc non converti)."""
    crlf = raw.count("\r\n")
    lf = raw.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"


def read_text_eol(path: Path) -> tuple[str, str]:
    """Lit un fichier en UTF-8 SANS conversion : retourne (texte avec \\n, fin de ligne d'origine)."""
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        raw = f.read()
    eol = detect_eol(raw)
    return raw.replace("\r\n", "\n"), eol


def write_text_eol(path: Path, text: str, eol: str = "\n") -> None:
    """Écrit en UTF-8 avec la fin de ligne demandée, identique sous Linux et Windows (aucune conversion implicite)."""
    text = text.replace("\r\n", "\n")
    if eol == "\r\n":
        text = text.replace("\n", "\r\n")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def eol_for_new_file(pref: str = "lf", platform: str | None = None) -> str:
    """Fin de ligne d'un fichier créé : lf (défaut, ce qu'attend Git), crlf, ou native (CRLF sous Windows)."""
    if pref == "crlf" or (pref == "native" and is_windows(platform)):
        return "\r\n"
    return "\n"


# --- Polices ---------------------------------------------------------------------------------------------------

def windows_font_dirs() -> list[Path]:
    dirs = [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"]
    if os.environ.get("LOCALAPPDATA"):
        dirs.append(Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts")
    return dirs


def nerd_font_on_windows() -> bool:
    for d in windows_font_dirs():
        try:
            if any("nerd" in p.name.lower() for p in d.iterdir()):
                return True
        except OSError:
            continue
    return False
