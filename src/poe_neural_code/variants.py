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


# Niveaux simples (CLI et desktop) traduits vers les valeurs RÉELLES du modèle actif (jamais inventées).
LEVELS = ("rapide", "normal", "profond")
LEVEL_ALIASES = {"fast": "rapide", "quick": "rapide", "rapide": "rapide", "normal": "normal", "moyen": "normal", "deep": "profond", "profond": "profond"}
_PREF = {"rapide": ("low", "minimal", "fast"), "normal": ("medium", "standard", "auto"), "profond": ("high", "xhigh", "max")}


def level_value(p: ParamSpec | None, level: str) -> str | None:
    """Valeur du modèle pour un niveau simple : rapide → low (sinon la plus basse), normal → medium (sinon celle du milieu),
    profond → high (sinon la plus haute). None : « défaut » (le modèle décide) ou aucun réglage d'effort."""
    level = LEVEL_ALIASES.get((level or "").strip().lower(), "")
    if not p or not p.choices or level not in LEVELS:
        return None
    ch = [str(c) for c in p.choices]
    for want in _PREF[level]:
        if want in ch:
            return want
    return {"rapide": ch[0], "normal": ch[len(ch) // 2], "profond": ch[-1]}[level]


def level_of(p: ParamSpec | None, value) -> str | None:
    """Niveau simple correspondant à une valeur du modèle (pour l'affichage), sinon None."""
    if p is None or value is None:
        return None
    return next((lv for lv in LEVELS if level_value(p, lv) == str(value)), None)


def effective(params: list[ParamSpec], options: dict, default_level: str | None) -> dict:
    """Réglages envoyés au modèle : ceux choisis + l'effort par défaut des réglages s'il n'a pas été choisi pour ce modèle."""
    out = dict(options)
    p = effort_param(params)
    if p and p.name not in out:
        v = level_value(p, default_level or "")
        if v is not None:
            out[p.name] = v
    return out


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
