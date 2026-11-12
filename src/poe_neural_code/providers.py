"""Registre des fournisseurs API (préréglages + personnalisés) et fabrique de connecteurs."""
from __future__ import annotations

import json
from dataclasses import dataclass

from . import credentials
from .paths import data_dir
from .provider.base import Provider
from .provider.openai_compat import OpenAICompatProvider
from .provider.poe import PoeProvider


@dataclass
class ProviderSpec:
    id: str
    label: str
    base_url: str
    key_env: str | None
    key_required: bool = True
    verified: str = "non testé avec une vraie clé"  # état de vérification, affiché à l'utilisateur
    notes: str = ""
    custom: bool = False


PRESETS: list[ProviderSpec] = [
    ProviderSpec("poe", "Poe", "https://api.poe.com/v1", "POE_API_KEY", verified="catalogue testé en réel ; chat testé contre un faux serveur"),
    ProviderSpec("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY",
                 verified="catalogue public testé en réel (prix, outils, effort)", notes="une clé pour des centaines de modèles"),
    ProviderSpec("openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY", verified="adresse vérifiée (401 sans clé) ; chat non testé"),
    ProviderSpec("anthropic", "Anthropic (API)", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY",
                 verified="adresse vérifiée ; couche de compatibilité OpenAI d'Anthropic (limitée)", notes="pour votre abonnement Claude, préférez Claude Code"),
    ProviderSpec("google", "Google Gemini (API)", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY", verified="adresse NON vérifiée (404 sans clé)"),
    ProviderSpec("mistral", "Mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY", verified="adresse vérifiée ; chat non testé"),
    ProviderSpec("groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", verified="adresse vérifiée ; chat non testé"),
    ProviderSpec("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", verified="adresse vérifiée ; chat non testé"),
    ProviderSpec("xai", "xAI (Grok)", "https://api.x.ai/v1", "XAI_API_KEY", verified="adresse vérifiée ; chat non testé"),
    ProviderSpec("together", "Together AI", "https://api.together.xyz/v1", "TOGETHER_API_KEY", verified="adresse vérifiée ; chat non testé"),
    ProviderSpec("ollama", "Ollama (local)", "http://localhost:11434/v1", None, key_required=False, verified="local : nécessite `ollama serve`"),
    ProviderSpec("lmstudio", "LM Studio (local)", "http://localhost:1234/v1", None, key_required=False, verified="local : serveur LM Studio actif requis"),
]


def _custom_file():
    return data_dir() / "providers.json"


def load_custom() -> list[ProviderSpec]:
    try:
        raw = json.loads(_custom_file().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    return [ProviderSpec(c["id"], c.get("label", c["id"]), c["base_url"], c.get("key_env"), c.get("key_required", True),
                         "personnalisé", "", True) for c in raw]


def save_custom(spec: ProviderSpec) -> None:
    items = [c for c in load_custom() if c.id != spec.id] + [spec]
    _custom_file().write_text(json.dumps([{"id": c.id, "label": c.label, "base_url": c.base_url, "key_env": c.key_env,
                                           "key_required": c.key_required} for c in items], indent=2), encoding="utf-8")


def all_specs() -> list[ProviderSpec]:
    ids = {p.id for p in PRESETS}
    return PRESETS + [c for c in load_custom() if c.id not in ids]


def get_spec(pid: str) -> ProviderSpec | None:
    return next((s for s in all_specs() if s.id == pid), None)


def has_credentials(spec: ProviderSpec) -> bool:
    return (not spec.key_required) or credentials.get_key(spec.id, spec.key_env) is not None


def build_provider(spec: ProviderSpec, transport=None) -> Provider:
    if spec.id == "poe":
        return PoeProvider(transport=transport)  # type: ignore[return-value]
    return OpenAICompatProvider(spec.id, spec.base_url, lambda: credentials.get_key(spec.id, spec.key_env), label=spec.label, key_env=spec.key_env,
                                key_required=spec.key_required, transport=transport)  # type: ignore[return-value]
