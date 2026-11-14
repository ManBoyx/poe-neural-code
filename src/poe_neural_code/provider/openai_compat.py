"""Connecteur générique pour toute API « compatible OpenAI » (OpenAI, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Ollama, LM Studio…).

Même contrat que PoeProvider (streaming, appels d'outils natifs, usage tokens, réglages par modèle). Ce que l'API ne fournit pas reste « inconnu » :
prix, fenêtre de contexte, réglages — jamais inventés.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, AsyncIterator

import httpx

from .base import (Capabilities, Done, Event, ModelInfo, NotConfigured, Notice, ParamSpec, ProviderError, TextDelta, ThinkingDelta, ToolCall, Usage)

HINTS = {401: "clé invalide ou expirée", 402: "crédits insuffisants", 403: "accès refusé", 404: "modèle ou endpoint introuvable",
         408: "délai dépassé côté modèle", 413: "requête plus grande que la fenêtre de contexte", 429: "limite de débit atteinte"}
NON_CHAT = re.compile(r"embed|whisper|tts|dall-e|moderation|rerank|image|transcribe|speech|audio|davinci|babbage", re.I)


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_generic_model(d: dict[str, Any]) -> ModelInfo:
    """Lit un élément de GET /models. Gère le format OpenRouter (prix, contexte, supported_parameters) quand il est présent."""
    sp = d.get("supported_parameters")
    price = d.get("pricing") or {}
    params: list[ParamSpec] = []
    if sp and "reasoning_effort" in sp:
        params.append(ParamSpec("reasoning_effort", "enum", ["low", "medium", "high"], None, "Effort de raisonnement (valeurs standard OpenRouter)"))
    # paramètres d'échantillonnage standard : ceux que le catalogue déclare, sinon les standards OpenAI (prise en charge non vérifiée)
    std = [("temperature", "number", "Température (0 = déterministe, 2 = très créatif)"), ("top_p", "number", "Échantillonnage nucleus (0–1)"),
           ("seed", "integer", "Graine pour des réponses reproductibles"), ("frequency_penalty", "number", "Pénalité de répétition (-2–2)"),
           ("presence_penalty", "number", "Pénalité de présence (-2–2)"), ("top_k", "integer", "Top-k")]
    for name, kind, desc in std:
        if sp is not None and name in sp:
            params.append(ParamSpec(name, kind, [], None, desc))
        elif sp is None and name in ("temperature", "top_p", "seed"):
            params.append(ParamSpec(name, kind, [], None, desc + " — paramètre OpenAI standard, prise en charge non vérifiée pour ce modèle"))
    arch = d.get("architecture") or {}
    mods = d.get("modalities") or {}
    outs = arch.get("output_modalities") or mods.get("output")
    chat = (outs == ["text"] if outs else not NON_CHAT.search(d["id"]))
    return ModelInfo(id=d["id"], context_length=d.get("context_length") or d.get("context_window") or (d.get("top_provider") or {}).get("context_length"),
                     max_output=(d.get("top_provider") or {}).get("max_completion_tokens"),
                     prompt_price=_f(price.get("prompt")), completion_price=_f(price.get("completion")),
                     supports_tools=("tools" in sp) if sp is not None else True,  # liste absente : non vérifié, on tente (l'API refusera sinon)
                     chat_text=chat, params=params, reasoning=bool(sp and "reasoning" in sp), description=(d.get("description") or "")[:300],
                     owner=d.get("owned_by") or "", input_modalities=arch.get("input_modalities") or mods.get("input") or [])


class OpenAICompatProvider:
    capabilities = Capabilities(streaming=True, native_tools=True, reports_points=False, reports_usage_tokens=True)
    points_based = False

    def __init__(self, name: str, base_url: str, key_getter: Callable[[], str | None], label: str | None = None, key_env: str | None = None,
                 key_required: bool = True, parse_model: Callable[[dict], ModelInfo] = parse_generic_model, extra_headers: dict[str, str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None, timeout: float = 120.0):
        self.name, self.label, self.key_env = name, label or name, key_env
        self.base_url = base_url.rstrip("/")
        self._key_getter, self.key_required, self._parse, self.extra_headers = key_getter, key_required, parse_model, extra_headers or {}
        self.http = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(timeout, connect=15.0))

    def _key(self) -> str | None:
        return self._key_getter() or None

    def configured(self) -> bool:
        return (not self.key_required) or self._key() is not None

    async def aclose(self) -> None:
        await self.http.aclose()

    def _headers(self) -> dict[str, str]:
        h = dict(self.extra_headers)
        k = self._key()
        if k:
            h["Authorization"] = f"Bearer {k}"
        return h

    def _not_configured(self) -> NotConfigured:
        env = f" ou la variable {self.key_env}" if self.key_env else ""
        return NotConfigured(f"Connexion {self.label} non configurée : /connect{env}. Aucune réponse n'est simulée.")

    async def verify(self) -> tuple[bool, str]:
        """La clé est-elle acceptée ? (GET /models avec la clé : 401 = refusée.)"""
        try:
            ms = await self.list_models()
            return True, f"{len(ms)} modèles"
        except ProviderError as e:
            return (False, str(e)) if e.status == 401 else (True, f"clé non vérifiable ({e})")

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self.http.get(f"{self.base_url}/models", headers=self._headers())
            if r.status_code == 401:
                raise ProviderError(f"HTTP 401 — {HINTS[401]}", 401)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise ProviderError(f"Catalogue indisponible : {e.__class__.__name__}", retryable=True) from e
        return [self._parse(d) for d in r.json().get("data", []) if isinstance(d, dict) and "id" in d]

    async def stream(self, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None, max_tokens: int | None,
                     options: dict[str, Any] | None = None) -> AsyncIterator[Event]:
        if not self.configured():
            raise self._not_configured()
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": True, "stream_options": {"include_usage": True}}
        if tools:
            body["tools"] = tools
        if max_tokens:
            body["max_tokens"] = max_tokens
        if options:
            body.update({k: v for k, v in options.items() if k not in body})
        headers = self._headers()
        for attempt in (0, 1, 2):
            calls: dict[int, dict[str, str]] = {}
            finish: str | None = None
            try:
                async with self.http.stream("POST", f"{self.base_url}/chat/completions", headers=headers, json=body) as r:
                    if r.status_code == 400 and attempt < 2 and ("stream_options" in body or options):
                        await r.aread()
                        if "stream_options" in body:
                            body.pop("stream_options")
                        elif options:
                            for k in options:
                                body.pop(k, None)
                            options = None
                            yield Notice("Réglages du modèle refusés par l'API (HTTP 400) : requête renvoyée sans eux.")
                        continue
                    if r.status_code >= 400:
                        await r.aread()
                        try:
                            err = r.json().get("error", {})
                            msg = err.get("message", "") if isinstance(err, dict) else str(err)
                        except Exception:  # noqa: BLE001
                            msg = r.text[:200]
                        raise ProviderError(f"HTTP {r.status_code} — {HINTS.get(r.status_code, '')} {msg}".strip(), r.status_code,
                                            r.status_code in (408, 429, 500, 502, 503, 504))
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
