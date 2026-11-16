"""OpenCode Zen et OpenCode Go par clé d'API (https://opencode.ai).

Conditions d'usage respectées (documentation OpenCode, lue le 2026-11-16) :
- Zen : clé utilisable depuis d'autres outils pour les modèles PAYANTS ; « Free-tier chat models require OpenCode » :
  les modèles gratuits de Zen ne sont donc pas proposés ici (utilisez /free, qui passe par OpenCode lui-même).
- Go (abonnement) : réservé aux agents de code qui s'identifient par leur propre User-Agent et envoient un identifiant
  de session stable par conversation (en-tête x-opencode-session). Eclipse envoie les deux.
Le catalogue (public) indique pour chaque modèle l'API qu'il parle ; seuls les modèles « chat-completions » (format
OpenAI) sont proposés : ceux qui n'existent qu'en API Anthropic, Responses ou Google ne sont pas pilotables ici.
"""
from __future__ import annotations

import uuid
from typing import Any

from .. import __version__
from .base import ModelInfo, ParamSpec
from .openai_compat import OpenAICompatProvider, _f

CHAT_API = "chat-completions"


def is_free(d: dict[str, Any]) -> bool:
    text = ((d.get("cost") or {}).get("text") or {})
    return _f((text.get("input") or {}).get("price")) == 0 and _f((text.get("output") or {}).get("price")) == 0


def parse_opencode_model(d: dict[str, Any]) -> ModelInfo:
    cap = d.get("capabilities") or {}
    lim = d.get("limit") or {}
    text = ((d.get("cost") or {}).get("text") or {})
    pin, pout = _f((text.get("input") or {}).get("price")), _f((text.get("output") or {}).get("price"))
    reas = cap.get("reasoning") or {}
    params: list[ParamSpec] = []
    if reas.get("effort"):
        params.append(ParamSpec("reasoning_effort", "enum", [str(x) for x in reas["effort"]], None, "Effort de raisonnement (valeurs du catalogue OpenCode)"))
    if cap.get("temperature"):
        params.append(ParamSpec("temperature", "number", [], None, "Température (0 = déterministe)"))
    if cap.get("top_p"):
        params.append(ParamSpec("top_p", "number", [], None, "Échantillonnage nucleus (0–1)"))
    ins = (d.get("modalities") or {}).get("input") or []
    desc = " — ".join(x for x in (d.get("name"), d.get("description")) if x)
    if (d.get("cost") or {}).get("multipliers"):
        desc += " (prix de base ; majoré à certaines heures selon OpenCode)"
    return ModelInfo(id=d["id"], context_length=lim.get("context"), max_output=lim.get("output"),
                     prompt_price=pin / 1e6 if pin is not None else None, completion_price=pout / 1e6 if pout is not None else None,
                     supports_tools=bool((cap.get("tools") or {}).get("supported")), chat_text=d.get("type", "chat") == "chat",
                     params=params, reasoning=bool(reas.get("supported")), description=desc[:300], owner=d.get("owned_by") or "opencode",
                     input_modalities=sorted({str(m).split("/")[0] for m in ins}))


class OpenCodeProvider(OpenAICompatProvider):
    def __init__(self, name: str, catalog_url: str, chat_url: str, key_getter, label: str, key_env: str | None,
                 allow_free: bool, transport=None):
        super().__init__(name, catalog_url, key_getter, label=label, key_env=key_env, parse_model=parse_opencode_model,
                         extra_headers={"User-Agent": f"eclipse/{__version__}"}, transport=transport)
        self.default_chat_url = chat_url.rstrip("/")
        self.allow_free = allow_free
        self._chat_urls: dict[str, str] = {}
        # identifiant stable de la conversation (l'agent le remplace par celui de la conversation en cours)
        self.conversation_hint = uuid.uuid4().hex

    def _headers(self) -> dict[str, str]:
        h = super()._headers()
        h["x-opencode-session"] = self.conversation_hint
        return h

    async def list_models(self) -> list[ModelInfo]:
        out = []
        for d in await self._catalog():
            api = (d.get("api") or {}).get(CHAT_API)
            if not isinstance(api, dict) or (is_free(d) and not self.allow_free):
                continue
            self._chat_urls[d["id"]] = str(api.get("base_url") or self.default_chat_url).rstrip("/")
            out.append(self._parse(d))
        return out

    def _chat_url(self, model: str) -> str:
        return f"{self._chat_urls.get(model, self.default_chat_url)}/chat/completions"

    async def verify(self) -> tuple[bool, str]:
        # le catalogue est public : il ne prouve pas que la clé est bonne ; on ne paie pas un message pour le savoir
        ms = await self.list_models()
        return True, f"{len(ms)} modèles utilisables ; la clé sera vérifiée au premier message"
