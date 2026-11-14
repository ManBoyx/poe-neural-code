"""Configuration utilisateur (JSON dans le dossier de données).

Aucune gestion de clé API ici : le connecteur lit uniquement la variable d'environnement POE_API_KEY
(le sujet des clés est hors périmètre de cette version).
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from .paths import data_dir


class Config(BaseModel):
    provider: str = "poe"
    model: str | None = None  # aucun nom de modèle supposé : à choisir via /model
    max_output_tokens: int = 4096
    max_agent_steps: int = 25
    command_timeout_s: int = 120
    auto_accept_edits: bool = False
    sidebar_visible: bool = True
    # Taux points/USD saisi manuellement : sans lui, les points ne sont pas estimables.
    points_per_usd: float | None = None
    context_window_override: int | None = None
    reserve_for_output_ratio: float = 0.25  # part de la fenêtre réservée aux réponses et résultats d'outils
    compact_trigger_ratio: float = 0.6  # seuil de compactage (part de la fenêtre utile)
    claude_bin: str = "claude"  # exécutable Claude Code (mode « claude »)
    claude_model: str | None = None  # alias ou id passé à --model (défaut : celui de Claude Code)
    claude_max_usd_per_turn: float | None = None  # --max-budget-usd, équivalent API indicatif
    cli_models: dict[str, str] = Field(default_factory=dict)  # agent externe -> modèle (option --model de l'agent)
    fusion_enabled: bool = False
    fusion_helpers: list[str] = Field(default_factory=list)  # ids : claude | cli:ID | api:FOURNISSEUR/MODELE
    fusion_max_calls: int = 3  # consultations max par tour
    fusion_max_output: int = 2000  # tokens de sortie max demandés à un assistant API
    fusion_timeout_s: int = 300
    notify_after_s: int = 30  # signal sonore quand un tour dépasse cette durée
    desktop_notify: bool = False  # notification bureau (notify-send) en plus
    icons: str = "auto"  # auto | nerd | text — icônes Nerd Font ou symboles texte (jamais d'emoji)
    theme: str = "eclipse"
    favorite_models: list[str] = Field(default_factory=list)
    recent_models: list[str] = Field(default_factory=list)
    mcp_config: str | None = None  # chemin d'un mcp.json ; défaut : <données>/mcp.json
    recent_files: list[str] = Field(default_factory=list)


def _path():
    return data_dir() / "config.json"


def load_config() -> Config:
    p = _path()
    if p.exists():
        try:
            return Config.model_validate_json(p.read_text(encoding="utf-8"))
        except Exception:
            p.replace(p.with_suffix(".json.corrupt"))
    return Config()


def save_config(c: Config) -> None:
    _path().write_text(c.model_dump_json(indent=2), encoding="utf-8")
