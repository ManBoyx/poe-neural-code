"""Agents IA installés sur l'ordinateur (Claude Code, OpenCode, Gemini CLI, Codex, Kiro, Aider…) : détection et adaptateurs.

Seuls Claude Code (intégration complète : outils d'Eclipse via pont MCP) et OpenCode (format JSON observé en réel, mémoire d'Eclipse par MCP)
sont vérifiés. Les autres préréglages reposent sur les options lues dans l'aide du programme (Gemini) ou sur leur documentation, non vérifiée
ici : ils sont étiquetés comme tels. Un adaptateur personnalisé se déclare dans `<données>/agents.json`.

DÉTECTION : une application lancée depuis le menu du bureau (AppImage, raccourci .desktop) hérite du PATH de la session graphique, plus court
que celui du terminal (~/.local/bin, ~/.opencode/bin, nvm… y manquent souvent). Eclipse cherche donc dans : le PATH du processus, le PATH de
votre shell de connexion (lu une fois, avec délai maximal), les dossiers d'installation courants, et un chemin indiqué à la main
(config `agent_paths`). Chaque agent est détecté séparément : un échec (délai, plantage) n'empêche jamais la détection des autres.

MODE DÉLÉGUÉ : l'agent externe exécute ses PROPRES outils ; Eclipse ne peut pas en prévisualiser les commandes. Eclipse mesure/estime les tokens,
applique la limite (avant et pendant le tour), archive dans la mémoire et interrompt le processus à la demande.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .paths import data_dir
from . import platform_compat as PC


@dataclass
class CliAdapter:
    id: str
    label: str
    binary: str
    args: list[str] = field(default_factory=list)
    prompt_via: str = "arg"  # arg (dernier argument) | flag (prompt_flag + texte) | stdin
    prompt_flag: str = ""
    output: str = "text"  # text | opencode-json
    model_flag: str = ""
    plan_args: list[str] = field(default_factory=list)  # ajoutés en mode « plan » (lecture seule) quand l'agent le permet
    session_flag: str = ""
    verified: str = "non vérifié"
    notes: str = ""
    custom: bool = False
    integrated: bool = False  # Claude Code : intégration complète (pas le mode délégué)
    file_flag: str = ""  # option de l'agent pour joindre un fichier (OpenCode : --file)
    bypass_args: list[str] = field(default_factory=list)  # options de l'agent qui désactivent SES confirmations (mode bypass d'Eclipse)
    aliases: list[str] = field(default_factory=list)  # autres noms d'exécutable possibles
    version_args: list[str] = field(default_factory=lambda: ["--version"])
    memory: str = "notes"  # mcp : mémoire d'Eclipse branchée par MCP (vérifié) | notes : notes du projet ajoutées au premier message

    @property
    def scope_id(self) -> str:
        return "claude-code" if self.id == "claude" else f"cli:{self.id}"

    @property
    def binaries(self) -> list[str]:
        return [self.binary, *[b for b in self.aliases if b != self.binary]]


_NV = "options tirées de la documentation, NON vérifiées ici (agent non installé sur la machine de développement)"

# Table des agents connus. Ajouter un agent : une ligne (nom, binaire(s), commande de version, façon de lui passer la demande).
#   CliAdapter(id, libellé, binaire, args de base, prompt_via, prompt_flag, model_flag=…, plan_args=…, bypass_args=…, aliases=…, version_args=…)
A = CliAdapter
PRESETS: list[CliAdapter] = [
    A("claude", "Claude Code", "claude", verified="testé en réel : outils d'Eclipse via pont MCP, tokens mesurés, fenêtres d'abonnement",
      integrated=True, memory="mcp"),
    # --standalone : serveur privé (sinon `opencode run` se rattache au service OpenCode en arrière-plan, qui ignore notre
    # configuration MCP et travaille dans SON dossier — constaté avec opencode 2.1.4 et `opencode serve --service`)
    A("opencode", "OpenCode", "opencode", ["run", "--standalone", "--format", "json"], "arg", output="opencode-json", model_flag="--model", session_flag="--session",
      file_flag="--file", plan_args=["--agent", "plan"], bypass_args=["--auto"], memory="mcp",
      verified="testé en réel (opencode 2.1.4, modèle gratuit) : format JSON, mémoire d'Eclipse par MCP, fichiers dans le dossier de travail",
      notes="sans --auto par défaut : les permissions de l'agent restent les siennes (--auto seulement en mode bypass d'Eclipse)"),
    A("gemini", "Gemini CLI", "gemini", ["-o", "text"], "flag", "-p", model_flag="-m", plan_args=["--approval-mode", "plan"], bypass_args=["--approval-mode", "yolo"],
      verified="options lues dans --help ; NON testé (authentification refusée sur cette machine : offre individuelle retirée par Google)",
      notes="tokens estimés (sortie texte)"),
    A("codex", "Codex CLI", "codex", ["exec"], "arg", model_flag="-m", plan_args=["--sandbox", "read-only"],
      verified="NON installé ici, options NON vérifiées (confirmez avec `codex exec --help`)", notes="tokens estimés"),
    A("kiro", "Kiro CLI", "kiro-cli", ["chat", "--no-interactive"], "arg", bypass_args=["--trust-all-tools"],
      verified="NON installé ici, options NON vérifiées (confirmez avec `kiro-cli chat --help`)", notes="tokens estimés"),
    A("aider", "Aider", "aider", ["--no-pretty", "--no-auto-commits"], "flag", "--message", model_flag="--model", bypass_args=["--yes-always"],
      verified=_NV, notes="tokens estimés ; Aider ne modifie que les fichiers ajoutés à sa conversation"),
    A("goose", "Goose", "goose", ["run"], "flag", "-t", verified=_NV, notes="tokens estimés"),
    A("qwen", "Qwen Code", "qwen", [], "flag", "-p", model_flag="-m", plan_args=["--approval-mode", "plan"], bypass_args=["--yolo"],
      verified=_NV, notes="tokens estimés"),
    A("cursor", "Cursor CLI", "cursor-agent", ["-p", "--output-format", "text"], "arg", model_flag="--model", bypass_args=["--force"],
      verified=_NV, notes="tokens estimés"),
    A("copilot", "GitHub Copilot CLI", "copilot", [], "flag", "-p", model_flag="--model", bypass_args=["--allow-all-tools"],
      verified=_NV, notes="tokens estimés ; sans bypass, les outils qui demandent une confirmation sont refusés"),
    A("amp", "Amp", "amp", [], "flag", "-x", bypass_args=["--dangerously-allow-all"], verified=_NV, notes="tokens estimés"),
    A("crush", "Crush", "crush", ["run"], "arg", bypass_args=["--yolo"], verified=_NV, notes="tokens estimés"),
    A("droid", "Droid (Factory)", "droid", ["exec"], "arg", model_flag="-m", bypass_args=["--skip-permissions-unsafe"],
      verified=_NV, notes="tokens estimés ; `droid exec` est en lecture seule tant qu'on ne lui donne pas --auto"),
    A("cline", "Cline CLI", "cline", [], "arg", verified=_NV + " ; mode non interactif à confirmer avec `cline --help`", notes="tokens estimés"),
]
del A


def load_custom() -> list[CliAdapter]:
    f = data_dir() / "agents.json"
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    out = []
    for c in raw:
        try:
            out.append(CliAdapter(c["id"], c.get("label", c["id"]), c["binary"], c.get("args", []), c.get("prompt_via", "arg"), c.get("prompt_flag", ""),
                                  c.get("output", "text"), c.get("model_flag", ""), c.get("plan_args", []), c.get("session_flag", ""),
                                  "personnalisé", c.get("notes", ""), custom=True, aliases=c.get("aliases", []),
                                  version_args=c.get("version_args", ["--version"])))
        except (KeyError, TypeError):
            continue
    return out


def all_adapters() -> list[CliAdapter]:
    ids = {a.id for a in PRESETS}
    return PRESETS + [c for c in load_custom() if c.id not in ids]


def get_adapter(aid: str) -> CliAdapter | None:
    return next((a for a in all_adapters() if a.id == aid), None)


# ---------------------------------------------------------------------------------------------------------- recherche des exécutables
SRC_PATH = "PATH"
SRC_SHELL = "PATH de votre shell"
SRC_KNOWN = "dossier d'installation courant"
SRC_MANUAL = "chemin indiqué à la main"


def _scan_mode() -> str:
    """ECLIPSE_AGENT_SCAN=path : seulement le PATH du processus (tests, environnements verrouillés)."""
    return os.environ.get("ECLIPSE_AGENT_SCAN", "full")


def known_dirs(home: Path | None = None, platform: str | None = None) -> list[str]:
    """Dossiers où les installateurs courants déposent les agents (npm global, nvm, fnm, pnpm, bun, volta, cargo, installateurs maison)."""
    h = Path(home) if home else Path.home()
    out: list[Path] = []
    if PC.is_windows(platform):
        env = os.environ
        for base, rel in (("APPDATA", "npm"), ("LOCALAPPDATA", r"Microsoft\WinGet\Links"), ("LOCALAPPDATA", r"Programs\cursor-agent"),
                          ("LOCALAPPDATA", r"pnpm"), ("ProgramFiles", "nodejs")):
            if env.get(base):
                out.append(Path(env[base]) / rel)
        out += [h / ".local" / "bin", h / ".bun" / "bin", h / ".cargo" / "bin", h / "scoop" / "shims", h / ".opencode" / "bin", h / ".volta" / "bin",
                h / ".claude" / "local", h / ".deno" / "bin"]
    else:
        out += [h / ".local" / "bin", h / "bin", h / ".opencode" / "bin", h / ".claude" / "local", h / ".claude" / "bin", h / ".kiro" / "bin",
                h / ".local" / "share" / "kiro-cli" / "bin", h / ".cargo" / "bin", h / ".bun" / "bin", h / ".deno" / "bin", h / ".volta" / "bin",
                h / ".npm-global" / "bin", h / ".npm-packages" / "bin", h / ".local" / "share" / "pnpm", h / "Library" / "pnpm", h / ".yarn" / "bin",
                h / ".config" / "yarn" / "global" / "node_modules" / ".bin", h / ".local" / "share" / "mise" / "shims", h / ".asdf" / "shims",
                h / ".amp" / "bin", h / ".factory" / "bin", h / "go" / "bin",
                Path("/usr/local/bin"), Path("/opt/homebrew/bin"), Path("/home/linuxbrew/.linuxbrew/bin"), Path("/snap/bin"),
                Path("/var/lib/snapd/snap/bin"), Path("/usr/bin"), Path("/bin")]
        # versions de Node gérées par nvm / fnm : la plus récente d'abord
        for pat in (h / ".nvm" / "versions" / "node" / "*" / "bin", h / ".local" / "share" / "fnm" / "node-versions" / "*" / "installation" / "bin",
                    h / ".fnm" / "node-versions" / "*" / "installation" / "bin"):
            out += [Path(p) for p in sorted(glob.glob(str(pat)), key=_version_key, reverse=True)]
        # préfixe npm personnalisé (~/.npmrc : prefix=…)
        try:
            for line in (h / ".npmrc").read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("prefix"):
                    out.append(Path(os.path.expanduser(line.split("=", 1)[1].strip())) / "bin")
        except (OSError, IndexError):
            pass
    return [str(p) for p in out]


def _version_key(p: str) -> tuple:
    parts = []
    for seg in Path(p).parts:
        if seg[:1] == "v" and seg[1:2].isdigit():
            seg = seg[1:]
        if seg[:1].isdigit():
            parts = [int(x) if x.isdigit() else 0 for x in seg.split(".")]
    return tuple(parts)


_shell_lock = threading.Lock()
_shell_cache: tuple[float, list[str], str] | None = None
_MARK = "__ECLIPSE_PATH__"


def shell_path(refresh: bool = False, timeout: float = 4.0) -> tuple[list[str], str]:
    """(dossiers du PATH de votre shell de connexion, message d'erreur éventuel). Lu une fois puis gardé 5 minutes (refresh=True : relu)."""
    global _shell_cache
    if _scan_mode() == "path" or PC.is_windows():
        return [], ""
    with _shell_lock:
        if _shell_cache and not refresh and time.time() - _shell_cache[0] < 300:
            return _shell_cache[1], _shell_cache[2]
        dirs, err = _read_shell_path(timeout)
        _shell_cache = (time.time(), dirs, err)
        return dirs, err


def _read_shell_path(timeout: float) -> tuple[list[str], str]:
    shell = os.environ.get("SHELL") or ""
    if not shell:
        try:
            import pwd
            shell = pwd.getpwuid(os.getuid()).pw_shell
        except Exception:  # noqa: BLE001
            shell = ""
    if not shell or not os.access(shell, os.X_OK):
        return [], "shell de connexion introuvable"
    name = Path(shell).name
    if name == "fish":
        argv = [shell, "-l", "-i", "-c", f'printf "%s" "{_MARK}"(string join : $PATH)"{_MARK}"']
    elif name in ("bash", "zsh", "ksh", "mksh"):
        argv = [shell, "-l", "-i", "-c", f'printf "{_MARK}%s{_MARK}" "$PATH"']
    else:
        argv = [shell, "-l", "-c", f'printf "{_MARK}%s{_MARK}" "$PATH"']
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, errors="replace")
    except subprocess.TimeoutExpired:
        return [], f"{name} n'a pas répondu en {timeout:.0f} s"
    except OSError as e:
        return [], f"{name} : {e}"
    out = r.stdout or ""
    i, j = out.find(_MARK), out.rfind(_MARK)
    if i < 0 or j <= i:
        return [], f"{name} n'a pas renvoyé de PATH"
    return [d for d in out[i + len(_MARK):j].split(os.pathsep) if d], ""


def search_dirs(env_path: str | None = None, shell_dirs: list[str] | None = None, home: Path | None = None,
                refresh: bool = False) -> list[tuple[str, str]]:
    """[(dossier, source)] dans l'ordre de recherche, sans doublons. Les arguments servent aux tests (PATH réduit, etc.)."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []

    def add(d: str, src: str) -> None:
        if not d:
            return
        key = os.path.normcase(os.path.abspath(os.path.expanduser(d)))
        if key not in seen:
            seen.add(key)
            out.append((key, src))

    for d in (os.environ.get("PATH", "") if env_path is None else env_path).split(os.pathsep):
        add(d, SRC_PATH)
    if _scan_mode() != "path" or shell_dirs is not None:
        for d in (shell_path(refresh)[0] if shell_dirs is None else shell_dirs):
            add(d, SRC_SHELL)
    if _scan_mode() != "path" or home is not None:
        for d in known_dirs(home):
            add(d, SRC_KNOWN)
    return out


def _executable(p: str) -> bool:
    return os.path.isfile(p) and (PC.is_windows() or os.access(p, os.X_OK))


def _manual_paths(config=None) -> dict[str, str]:
    try:
        cfg = config
        if cfg is None:
            from .config import load_config
            cfg = load_config()
        out = dict(getattr(cfg, "agent_paths", {}) or {})
        cb = getattr(cfg, "claude_bin", "claude")
        if cb and cb != "claude" and "claude" not in out:
            out["claude"] = cb  # ancien réglage claude_bin : même effet qu'un chemin manuel
        return out
    except Exception:  # noqa: BLE001
        return {}


@dataclass
class Detected:
    adapter: CliAdapter
    path: str | None
    version: str = ""
    source: str = ""  # PATH | PATH de votre shell | dossier d'installation courant | chemin indiqué à la main
    reason: str = ""  # pourquoi l'agent n'a pas été trouvé (ou pourquoi le chemin manuel est ignoré)
    version_error: str = ""
    real_path: str = ""  # cible du lien symbolique

    @property
    def installed(self) -> bool:
        return self.path is not None

    def to_json(self) -> dict:
        a = self.adapter
        return {"id": "claude" if a.id == "claude" else f"cli:{a.id}", "agent": a.id, "label": a.label, "installed": self.installed,
                "path": self.path, "real_path": self.real_path, "version": self.version, "source": self.source, "reason": self.reason,
                "version_error": self.version_error, "binaries": a.binaries, "note": a.verified, "memory": a.memory, "custom": a.custom}


def locate(a: CliAdapter, dirs: list[tuple[str, str]] | None = None, manual: str | None = None) -> Detected:
    """Cherche UN agent : chemin manuel d'abord, puis chaque nom de binaire dans chaque dossier (ordre de `search_dirs`)."""
    warn = ""
    if manual:
        m = os.path.abspath(os.path.expanduser(manual))
        if _executable(m):
            return Detected(a, m, source=SRC_MANUAL, real_path=os.path.realpath(m))
        warn = f"chemin indiqué à la main ignoré : {m} " + ("n'est pas exécutable" if os.path.isfile(m) else "n'existe pas") + " ; "
    dirs = search_dirs() if dirs is None else dirs
    for name in a.binaries:
        for d, src in dirs:
            p = shutil.which(name, path=d)
            if p and _executable(p):
                return Detected(a, p, source=src, reason=warn.rstrip(" ;"), real_path=os.path.realpath(p))
    srcs = sorted({s for _, s in dirs})
    return Detected(a, None, reason=warn + f"« {' » ou « '.join(a.binaries)} » introuvable dans {len(dirs)} dossiers ({', '.join(srcs) or 'aucun'})")


def agent_env(binary: str | None = None, base: dict | None = None) -> dict[str, str]:
    """Environnement pour lancer un agent : PATH complété (le script de l'agent doit trouver `node`, etc., même lancé depuis le menu)."""
    env = dict(os.environ if base is None else base)
    dirs = ([os.path.dirname(binary)] if binary else []) + [d for d, _ in search_dirs(env.get("PATH", ""))]
    seen: set[str] = set()
    env["PATH"] = os.pathsep.join(d for d in dirs if d and not (d in seen or seen.add(d)) and os.path.isdir(d))
    return env


def find_binary(aid: str, config=None) -> str | None:
    """Chemin de l'exécutable d'un agent (même recherche que /connect), ou None."""
    a = get_adapter(aid)
    if a is None:
        return None
    try:
        return locate(a, manual=_manual_paths(config).get(aid)).path
    except Exception:  # noqa: BLE001
        return None


def _version(d: Detected, timeout: float) -> None:
    try:
        r = subprocess.run(PC.resolve_argv([d.path, *d.adapter.version_args]), capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, env=agent_env(d.path), errors="replace")
        lines = [ln.strip() for ln in ((r.stdout or "") + "\n" + (r.stderr or "")).splitlines() if ln.strip()]
        line = next((ln for ln in lines if any(ch.isdigit() for ch in ln)), lines[0] if lines else "")
        d.version = line[:60]
        if not d.version:
            d.version_error = f"aucune version renvoyée (code {r.returncode})"
    except subprocess.TimeoutExpired:
        d.version_error = f"« {' '.join(d.adapter.version_args)} » sans réponse en {timeout:.0f} s"
    except Exception as e:  # noqa: BLE001
        d.version_error = f"version illisible : {e.__class__.__name__}: {e}"[:160]


def detect(with_version: bool = False, *, config=None, refresh: bool = False, dirs: list[tuple[str, str]] | None = None,
           timeout: float = 5.0) -> list[Detected]:
    """Détecte TOUS les agents connus, chacun isolé (un plantage ou un délai sur l'un n'empêche pas les autres). Aucun cache des résultats."""
    adapters = all_adapters()
    manual = _manual_paths(config)
    try:
        dirs = search_dirs(refresh=refresh) if dirs is None else dirs
    except Exception as e:  # noqa: BLE001 — repli : PATH seul
        dirs = [(d, SRC_PATH) for d in os.environ.get("PATH", "").split(os.pathsep) if d]
        manual.setdefault("__err__", str(e))

    def one(a: CliAdapter) -> Detected:
        try:
            d = locate(a, dirs, manual.get(a.id))
        except Exception as e:  # noqa: BLE001
            return Detected(a, None, reason=f"détection impossible : {e.__class__.__name__}: {e}"[:200])
        if d.installed and with_version:
            _version(d, timeout)
        return d

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(adapters)))) as ex:
        futs = [ex.submit(one, a) for a in adapters]
        out = []
        for a, f in zip(adapters, futs):
            try:
                out.append(f.result(timeout=timeout + 5))
            except Exception as e:  # noqa: BLE001
                out.append(Detected(a, None, reason=f"détection interrompue : {e.__class__.__name__}"))
    return out


def build_command(a: CliAdapter, binary: str, prompt: str, *, model: str | None = None, plan: bool = False, session_id: str | None = None, bypass: bool = False,
                  files: list | None = None) -> tuple[list[str], str | None]:
    """(commande, texte pour stdin ou None)."""
    cmd = [binary, *a.args]
    if plan and a.plan_args:
        cmd += a.plan_args
    elif bypass and a.bypass_args:  # jamais en mode plan (lecture seule prime)
        cmd += a.bypass_args
    if model and a.model_flag:
        cmd += [a.model_flag, model]
    if session_id and a.session_flag:
        cmd += [a.session_flag, session_id]
    for f in files or []:
        if a.file_flag:
            cmd += [a.file_flag, str(f)]
        else:
            prompt += f"\n[Fichier joint : {f}]"
    if a.prompt_via == "flag":
        cmd += [a.prompt_flag, prompt]
        return cmd, None
    if a.prompt_via == "stdin":
        return cmd, prompt
    return cmd + [prompt], None


def parse_opencode_line(line: str) -> dict:
    """Une ligne JSON d'OpenCode → {text?, session?, tokens?:(in,out), kind}. Tolérant : les types inconnus sont ignorés, jamais devinés."""
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return {"kind": "raw", "text": line}
    out: dict = {"kind": ev.get("type", "?"), "session": ev.get("sessionID")}
    part = ev.get("part") or {}
    if ev.get("type") == "text" and isinstance(part.get("text"), str):
        out["text"] = part["text"]
    tk = part.get("tokens") or ev.get("tokens")
    if isinstance(tk, dict) and isinstance(tk.get("input"), int) and isinstance(tk.get("output"), int):
        out["tokens"] = (tk["input"], tk["output"])
    return out
