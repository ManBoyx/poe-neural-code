"""Connecteur Poe (API compatible OpenAI) — envoi, streaming, appels d'outils natifs.

Documenté (creator.poe.com, lu le 2026-11-09) : POST /v1/chat/completions (stream, tools, usage tokens),
GET /v1/models (public, avec prix et fonctions prises en charge). La clé est lue dans POE_API_KEY uniquement.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

import httpx

from .base import (Capabilities, Done, Event, ModelInfo, NotConfigured, Notice, ParamSpec, ProviderError, TextDelta, ThinkingDelta,
                   ToolCall, Usage)

BASE = "https://api.poe.com"
HINTS = {401: "clé invalide ou expirée", 402: "crédits insuffisants chez Poe", 403: "accès refusé", 404: "modèle introuvable",
         408: "délai dépassé côté modèle", 413: "requête plus grande que la fenêtre de contexte",
         429: "limite de débit (500 requêtes/min)"}


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


class PoeProvider:
    name = "poe"
    capabilities = Capabilities(streaming=True, native_tools=True, reports_points=False, reports_usage_tokens=True)

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 120.0):
        self.http = httpx.AsyncClient(base_url=BASE, transport=transport, timeout=httpx.Timeout(timeout, connect=15.0))

    def _key(self) -> str | None:
        from .. import credentials
        return credentials.get_key("poe", "POE_API_KEY")

    def configured(self) -> bool:
        return self._key() is not None

    async def aclose(self) -> None:
        await self.http.aclose()

    async def verify(self) -> tuple[bool, str]:
        """Le catalogue Poe est public : la clé se vérifie via /usage/current_balance (401 = refusée ; format de réponse non vérifié)."""
        try:
            r = await self.http.get("/usage/current_balance", headers={"Authorization": f"Bearer {self._key()}"})
        except httpx.HTTPError as e:
            return True, f"clé non vérifiable ({e.__class__.__name__})"
        if r.status_code == 401:
            return False, "HTTP 401 — clé invalide ou expirée"
        return True, "clé acceptée"

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self.http.get("/v1/models")
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ProviderError(f"Catalogue indisponible : {e.__class__.__name__}", retryable=True) from e
        out = []
        for d in r.json().get("data", []):
            arch, price, cw = d.get("architecture") or {}, d.get("pricing") or {}, d.get("context_window") or {}
            params = []
            for pr in d.get("parameters") or []:
                sc = pr.get("schema") or {}
                kind = "enum" if sc.get("enum") else {"boolean": "boolean", "integer": "integer", "number": "number"}.get(sc.get("type"), "string")
                params.append(ParamSpec(pr["name"], kind, [str(x) for x in sc.get("enum", [])], pr.get("default_value"), pr.get("description") or ""))
            out.append(ModelInfo(params=params, reasoning=bool(d.get("reasoning")), description=(d.get("description") or "")[:300],
                                 owner=d.get("owned_by") or "", input_modalities=arch.get("input_modalities") or [],
                id=d["id"], context_length=cw.get("context_length") or d.get("context_length"), max_output=cw.get("max_output_tokens"),
                prompt_price=_f(price.get("prompt")), completion_price=_f(price.get("completion")),
                cache_read_price=_f(price.get("input_cache_read")),
                supports_tools="tools" in (d.get("supported_features") or []),
                chat_text=arch.get("output_modalities") == ["text"] and "/v1/chat/completions" in (d.get("supported_endpoints") or [])))
        return out

    async def stream(self, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None,
                     max_tokens: int | None, options: dict[str, Any] | None = None) -> AsyncIterator[Event]:
        key = self._key()
        if not key:
            raise NotConfigured("Connexion Poe non configurée : définissez la variable d'environnement POE_API_KEY. "
                                "Aucune réponse n'est simulée.")
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": True,
                                "stream_options": {"include_usage": True}}
        if tools:
            body["tools"] = tools
        if max_tokens:
            body["max_tokens"] = max_tokens
        if options:  # réglages propres au modèle (reasoning_effort, web_search…) : paramètres personnalisés au niveau racine du corps
            body.update({k: v for k, v in options.items() if k not in body})
        headers = {"Authorization": f"Bearer {key}"}
        for attempt in (0, 1, 2):
            calls: dict[int, dict[str, str]] = {}
            finish: str | None = None
            try:
                async with self.http.stream("POST", "/v1/chat/completions", headers=headers, json=body) as r:
                    if r.status_code == 400 and attempt < 2 and ("stream_options" in body or options):
                        await r.aread()
                        if "stream_options" in body:
                            body.pop("stream_options")  # option peut-être refusée : on réessaie sans
                        elif options:
                            for k in options:
                                body.pop(k, None)
                            options = None
                            yield Notice("Réglages du modèle refusés par l'API (HTTP 400) : requête renvoyée sans eux.")
                        continue
                    if r.status_code >= 400:
                        await r.aread()
                        try:
                            msg = r.json().get("error", {}).get("message", "")
                        except Exception:
                            msg = r.text[:200]
                        raise ProviderError(f"HTTP {r.status_code} — {HINTS.get(r.status_code, '')} {msg}".strip(),
                                            r.status_code, r.status_code in (408, 429, 500, 502, 503, 504))
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            d = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if d.get("usage"):
                            yield Usage(d["usage"].get("prompt_tokens"), d["usage"].get("completion_tokens"))
                        for ch in d.get("choices") or []:
                            delta = ch.get("delta") or {}
                            th = delta.get("reasoning_content") or delta.get("reasoning")
                            if isinstance(th, str) and th:
                                yield ThinkingDelta(th)
                            if delta.get("content"):
                                yield TextDelta(delta["content"])
                            for tc in delta.get("tool_calls") or []:
                                slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                                slot["id"] = tc.get("id") or slot["id"]
                                fn = tc.get("function") or {}
                                slot["name"] += fn.get("name") or ""
                                slot["args"] += fn.get("arguments") or ""
                            finish = ch.get("finish_reason") or finish
                for i in sorted(calls):
                    c = calls[i]
                    yield ToolCall(c["id"] or f"call_{i}", c["name"], c["args"] or "{}")
                yield Done(finish)
                return
            except httpx.HTTPError as e:
                raise ProviderError(f"Connexion interrompue ({e.__class__.__name__})", retryable=True) from e
