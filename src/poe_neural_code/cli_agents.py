"""Agents IA installés sur l'ordinateur (Claude Code, OpenCode, Gemini CLI, Codex, Kiro…) : détection et adaptateurs.

Seuls Claude Code (intégration complète : outils d'Eclipse via pont MCP) et OpenCode (format JSON observé en réel) sont vérifiés. Les autres
préréglages reposent sur les options lues dans l'aide du programme (Gemini) ou sur de la documentation non vérifiée ici (Codex, Kiro) :
ils sont étiquetés comme tels. Un adaptateur personnalisé se déclare dans `<données>/agents.json`.

MODE DÉLÉGUÉ : l'agent externe exécute ses PROPRES outils ; Eclipse ne peut pas en prévisualiser les commandes. Eclipse mesure/estime les tokens,
applique la limite (avant et pendant le tour), archive dans la mémoire et interrompt le processus à la demande.
"""
from __future__ import annotations

import json
import shutil
import subprocess
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
    file_flag: str = ""  # option de l'agent pour joindre un fichier (OpenCode : --file)
    bypass_args: list[str] = field(default_factory=list)  # options de l'agent qui désactivent SES confirmations (mode bypass d'Eclipse)
    verified: str = "non vérifié"
    notes: str = ""
    custom: bool = False
    integrated: bool = False  # Claude Code : intégration complète (pas le mode délégué)

    @property
    def scope_id(self) -> str:
        return "claude-code" if self.id == "claude" else f"cli:{self.id}"


PRESETS: list[CliAdapter] = [
    CliAdapter("claude", "Claude Code", "claude", verified="testé en réel : outils d'Eclipse via pont MCP, tokens mesurés, fenêtres d'abonnement",
               integrated=True),
    CliAdapter("opencode", "OpenCode", "opencode", ["run", "--format", "json"], "arg", output="opencode-json", model_flag="--model", session_flag="--session", file_flag="--file",
               plan_args=["--agent", "plan"], bypass_args=["--auto"], verified="format JSON testé en réel (texte reçu ; aucun compteur de tokens → estimé)",
               notes="sans --auto par défaut : les permissions de l'agent restent les siennes (--auto seulement en mode bypass d'Eclipse)"),
    CliAdapter("gemini", "Gemini CLI", "gemini", ["-o", "text"], "flag", "-p", model_flag="-m", plan_args=["--approval-mode", "plan"], bypass_args=["--approval-mode", "yolo"],
               verified="options lues dans --help ; NON testé (authentification refusée sur cette machine : offre individuelle retirée par Google)",
               notes="tokens estimés (sortie texte)"),
    CliAdapter("codex", "Codex CLI", "codex", ["exec"], "arg", model_flag="-m", plan_args=["--sandbox", "read-only"],
               verified="NON installé ici, options NON vérifiées (confirmez avec `codex exec --help`)", notes="tokens estimés"),
    CliAdapter("kiro", "Kiro CLI", "kiro-cli", ["chat", "--no-interactive"], "arg",
               verified="NON installé ici, options NON vérifiées (confirmez avec `kiro-cli chat --help`)", notes="tokens estimés"),
]


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
                                  "personnalisé", c.get("notes", ""), custom=True))
        except KeyError:
            continue
    return out


def all_adapters() -> list[CliAdapter]:
    ids = {a.id for a in PRESETS}
    return PRESETS + [c for c in load_custom() if c.id not in ids]


def get_adapter(aid: str) -> CliAdapter | None:
    return next((a for a in all_adapters() if a.id == aid), None)


@dataclass
class Detected:
    adapter: CliAdapter
    path: str | None
    version: str = ""

    @property
    def installed(self) -> bool:
        return self.path is not None


def detect(with_version: bool = False) -> list[Detected]:
    out = []
    for a in all_adapters():
        path = shutil.which(a.binary)
        v = ""
        if path and with_version:
            try:
                r = subprocess.run(PC.resolve_argv([path, "--version"]), capture_output=True, text=True, timeout=6)
                v = (r.stdout or r.stderr).strip().splitlines()[0][:60] if (r.stdout or r.stderr).strip() else ""
            except Exception:  # noqa: BLE001
                v = ""
        out.append(Detected(a, path, v))
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
