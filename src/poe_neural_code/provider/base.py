"""Interface fournisseur : tout ce que le reste de l'application sait d'un fournisseur.

Une seule implémentation (Poe) pour cette version ; un autre fournisseur n'aurait qu'à implémenter `Provider`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class NotConfigured(ProviderError):
    """Connexion non configurée : jamais de réponse simulée."""


@dataclass
class TextDelta:
    text: str


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # JSON brut tel que reçu (à valider par l'appelant)


@dataclass
class Usage:
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


@dataclass
class Done:
    finish_reason: str | None = None




@dataclass
class ParamSpec:
    """Réglage propre à un modèle, tel que décrit par le catalogue du fournisseur (jamais inventé)."""
    name: str
    kind: str  # enum | boolean | integer | number | string
    choices: list[str] = field(default_factory=list)
    default: Any = None
    description: str = ""


@dataclass
class ThinkingDelta:
    text: str


@dataclass
class Notice:
    text: str


Event = TextDelta | ToolCall | Usage | Done | ThinkingDelta | Notice


@dataclass
class ModelInfo:
    id: str
    context_length: int | None = None
    max_output: int | None = None
    prompt_price: float | None = None  # USD / token
    completion_price: float | None = None
    supports_tools: bool = False
    chat_text: bool = True
    cache_read_price: float | None = None
    params: list[ParamSpec] = field(default_factory=list)
    reasoning: bool = False
    description: str = ""
    owner: str = ""


@dataclass
class Capabilities:
    streaming: bool = True
    native_tools: bool = True
    reports_points: bool = False  # le fournisseur renvoie-t-il les points dépensés par requête ?
    reports_usage_tokens: bool = True


class Provider(Protocol):
    name: str
    capabilities: Capabilities

    def configured(self) -> bool: ...
    async def list_models(self) -> list[ModelInfo]: ...
    def stream(self, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None,
               max_tokens: int | None, options: dict[str, Any] | None = None) -> AsyncIterator[Event]: ...
    async def aclose(self) -> None: ...
