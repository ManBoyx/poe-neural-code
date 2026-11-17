"""Modèles GRATUITS : sources réellement disponibles, sans contourner les conditions des services.

- OpenCode : modèles « -free » utilisables SANS compte via l'agent OpenCode installé (mode délégué). Leur API directe refuse l'usage hors d'OpenCode
  (« Free models work in OpenCode ») : Eclipse passe donc par OpenCode lui-même, jamais en imitant son client.
- OpenRouter : modèles « :free » (catalogue public), avec un compte gratuit et sa clé ; limites quotidiennes fixées par OpenRouter. Contrôle complet par Eclipse.
- Ollama : modèles locaux (aucun coût, données privées) ; nécessite `ollama serve` et le téléchargement d'un modèle (plusieurs Go) ; lent sans carte graphique.
- Offres gratuites avec clé (Groq, Google AI Studio, Mistral, Cerebras, GitHub Models) : quotas variables, conditions à lire chez chaque fournisseur.
"""
from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass

import httpx

from .cli_agents import find_binary
from .providers import get_spec, has_credentials

OLLAMA_SUGGESTED = [("qwen2.5-coder:3b", "≈ 2 Go · code · rapide sur CPU"), ("qwen2.5-coder:7b", "≈ 4,7 Go · code · plus lent"),
                    ("llama3.2:3b", "≈ 2 Go · généraliste")]


@dataclass
class FreeSource:
    id: str
    label: str
    ready: bool
    status: str
    how: str
    tradeoff: str


async def opencode_free_models(timeout: float = 40) -> list[str]:
    exe = find_binary("opencode")
    if not exe:
        return []
    try:
        p = await asyncio.create_subprocess_exec(exe, "models", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except Exception:  # noqa: BLE001
        return []
    return [l.strip() for l in out.decode(errors="replace").splitlines() if l.strip().endswith("-free") or l.strip().endswith(":free")]


async def openrouter_free_models(transport=None) -> list[dict]:
    try:
        async with httpx.AsyncClient(transport=transport, timeout=15) as c:
            r = await c.get("https://openrouter.ai/api/v1/models")
            r.raise_for_status()
    except Exception:  # noqa: BLE001
        return []
    return [m for m in r.json().get("data", []) if m["id"].endswith(":free") or ((m.get("pricing") or {}).get("prompt") == "0" and (m.get("pricing") or {}).get("completion") == "0")]


async def ollama_status(transport=None) -> tuple[bool, list[str]]:
    """(serveur actif ?, modèles installés)."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=3) as c:
            r = await c.get("http://localhost:11434/api/tags")
            r.raise_for_status()
            return True, [m["name"] for m in r.json().get("models", [])]
    except Exception:  # noqa: BLE001
        return False, []


async def sources() -> list[FreeSource]:
    oc, orf, (ol_up, ol_models) = await asyncio.gather(opencode_free_models(), openrouter_free_models(), ollama_status())
    out = []
    out.append(FreeSource("opencode", "OpenCode (sans compte)", bool(oc),
                          f"{len(oc)} modèles gratuits" if oc else ("OpenCode non installé" if not find_binary("opencode") else "liste indisponible"),
                          "Choisir un modèle -free ; Eclipse pilote OpenCode en mode délégué", "aperçu des commandes impossible (OpenCode exécute ses outils) ; tokens estimés"))
    sp = get_spec("openrouter")
    tools = [m for m in orf if "tools" in (m.get("supported_parameters") or [])]
    out.append(FreeSource("openrouter", "OpenRouter :free", bool(sp and has_credentials(sp)),
                          f"{len(orf)} modèles gratuits dont {len(tools)} avec outils" + ("" if sp and has_credentials(sp) else " · clé requise (compte gratuit)"),
                          "Compte gratuit sur openrouter.ai → clé → /connect", "contrôle complet par Eclipse ; limites quotidiennes d'OpenRouter ; données envoyées à des tiers"))
    out.append(FreeSource("ollama", "Ollama (local)", ol_up and bool(ol_models),
                          ("actif · " + (", ".join(ol_models[:3]) or "aucun modèle")) if ol_up else ("installé, serveur arrêté" if shutil.which("ollama") else "non installé"),
                          "Démarrer le serveur puis télécharger un petit modèle", "100 % local et privé ; lent sans carte graphique ; plusieurs Go de disque"))
    for pid in ("groq", "google", "mistral", "cerebras", "github"):
        spc = get_spec(pid)
        if spc:
            out.append(FreeSource(pid, f"{spc.label} (offre gratuite)", has_credentials(spc), "clé enregistrée" if has_credentials(spc) else "clé requise",
                                  "Créer une clé gratuite chez le fournisseur → /connect", "quotas et conditions propres au fournisseur ; " + spc.verified))
    return out
