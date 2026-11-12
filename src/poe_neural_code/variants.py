"""Variantes / réglages d'effort : dépendent du MODÈLE ACTIF, lus dans le catalogue du fournisseur (jamais supposés)."""
from __future__ import annotations

from .provider.base import ModelInfo, ParamSpec

EFFORT_NAMES = ("reasoning_effort", "effort", "thinking_level", "output_effort")
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]


def claude_params() -> list[ParamSpec]:
    return [ParamSpec("effort", "enum", CLAUDE_EFFORTS, None, "Niveau d'effort de Claude Code (--effort) ; refusé par Claude Code si le modèle ne le gère pas")]


def effort_param(params: list[ParamSpec]) -> ParamSpec | None:
    for n in EFFORT_NAMES:
        for p in params:
            if p.name == n and p.kind == "enum" and p.choices:
                return p
    return None


def cycle(params: list[ParamSpec], options: dict) -> tuple[str, object] | None:
    """Passe à la valeur suivante du réglage d'effort : défaut → v1 → v2 … → défaut. None si le modèle n'en propose pas."""
    p = effort_param(params)
    if not p:
        return None
    seq: list = [None, *p.choices]
    cur = options.get(p.name)
    nxt = seq[(seq.index(cur) + 1) % len(seq)] if cur in seq else seq[1]
    return p.name, nxt


def summary(params: list[ParamSpec], options: dict) -> str:
    """Résumé court pour la ligne d'état : « effort high · web_search on »."""
    out = []
    for p in params:
        if p.name in options:
            v = options[p.name]
            out.append(f"{p.name}={'on' if v is True else 'off' if v is False else v}")
    return " · ".join(out)


def coerce(p: ParamSpec, raw: str):
    """Convertit une saisie en valeur typée selon le schéma du modèle ; ValueError si invalide."""
    r = raw.strip()
    if p.kind == "enum":
        if r not in p.choices:
            raise ValueError(f"valeurs permises : {', '.join(p.choices)}")
        return r
    if p.kind == "boolean":
        if r.lower() in ("1", "true", "on", "oui", "yes"):
            return True
        if r.lower() in ("0", "false", "off", "non", "no"):
            return False
        raise ValueError("booléen attendu (on/off)")
    if p.kind == "integer":
        return int(r)
    if p.kind == "number":
        return float(r)
    return r
