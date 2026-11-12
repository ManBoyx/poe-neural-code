"""Outils internes : todo (sans appel modèle supplémentaire) et mémoire (recherche, chargement, notes)."""
from __future__ import annotations

from .base import Tool, ToolContext, ToolResult


class TodoWrite(Tool):
    name = "todo_write"
    description = "Remplace la todo list de la session (visible dans la barre latérale). Statuts : pending, in_progress, done."
    schema = {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object", "properties": {"content": {"type": "string", "minLength": 1},
                                         "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}},
        "required": ["content"], "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}

    async def run(self, args, ctx: ToolContext):
        ctx.todos.replace(args["items"])
        d, n = ctx.todos.progress()
        return ToolResult(True, f"todo mise à jour : {d}/{n} terminées")


class MemorySearch(Tool):
    name = "memory_search"
    description = ("Recherche dans la mémoire persistante du projet (items structurés, résumés, archives). Filtres : kinds, since/until "
                   "(timestamps Unix), conversation_only. Retourne des références (archive:N, item:N, summary:N) chargeables avec memory_load.")
    schema = {"type": "object", "properties": {
        "query": {"type": "string", "minLength": 1}, "layers": {"type": "array", "items": {"enum": ["items", "summaries", "archive"]}},
        "kinds": {"type": "array", "items": {"type": "string"}}, "since": {"type": "number"}, "until": {"type": "number"},
        "conversation_only": {"type": "boolean"}, "limit": {"type": "integer", "minimum": 1, "maximum": 30}},
        "required": ["query"], "additionalProperties": False}

    async def run(self, args, ctx: ToolContext):
        if ctx.memory is None:
            return ToolResult(False, "mémoire indisponible")
        hits = ctx.memory.search(args["query"], district_id=ctx.district_id,
                                 conversation_id=ctx.conversation_id if args.get("conversation_only") else None,
                                 kinds=args.get("kinds"), layers=tuple(args.get("layers") or ("items", "summaries", "archive")),
                                 since=args.get("since"), until=args.get("until"), limit=args.get("limit", 8))
        if not hits:
            return ToolResult(True, "aucun résultat")
        return ToolResult(True, "\n".join(f"{h.ref} ({h.layer}) {h.text[:300]}" for h in hits))


class MemoryLoad(Tool):
    name = "memory_load"
    description = "Charge temporairement un passage exact (ref : archive:N avec contexte before/after, item:N ou summary:N)."
    schema = {"type": "object", "properties": {"ref": {"type": "string", "pattern": r"^(archive|item|summary):\d+$"},
                                               "before": {"type": "integer", "minimum": 0, "maximum": 10},
                                               "after": {"type": "integer", "minimum": 0, "maximum": 10}},
              "required": ["ref"], "additionalProperties": False}

    async def run(self, args, ctx: ToolContext):
        if ctx.memory is None or ctx.cache is None:
            return ToolResult(False, "mémoire indisponible")
        p = ctx.cache.load(ctx.memory, args["ref"], args.get("before", 2), args.get("after", 2))
        if p is None:
            return ToolResult(False, f"référence introuvable : {args['ref']}")
        p.in_model_context = True  # renvoyé au modèle par ce résultat d'outil
        return ToolResult(True, p.text[:20_000], {"refs": p.refs})


class MemoryNote(Tool):
    name = "memory_note"
    description = ("Enregistre une information structurée avec provenance : goal, constraint, fact, hypothesis, decision, task, error, question. "
                   "Distinguez faits, hypothèses et décisions. 'key' sert à détecter les contradictions ; 'replaces' met à jour un item (historique conservé).")
    schema = {"type": "object", "properties": {
        "kind": {"enum": ["goal", "constraint", "fact", "hypothesis", "decision", "task", "error", "question"]},
        "content": {"type": "string", "minLength": 1}, "key": {"type": "string"}, "rationale": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}, "description": "références archive:N ou chemins de fichiers"},
        "replaces": {"type": "integer"}}, "required": ["kind", "content"], "additionalProperties": False}

    async def run(self, args, ctx: ToolContext):
        if ctx.memory is None or ctx.district_id is None:
            return ToolResult(False, "mémoire indisponible")
        srcs = []
        for s in args.get("sources", []):
            if s.startswith("archive:") and s[8:].isdigit():
                srcs.append({"archive_id": int(s[8:])})
            else:
                srcs.append({"file_path": s})
        iid, cid = ctx.memory.add_item(ctx.district_id, args["kind"], args["content"], key=args.get("key"), sources=srcs,
                                       rationale=args.get("rationale", ""), replaces=args.get("replaces"))
        return ToolResult(True, f"enregistré item:{iid}" + (f" — CONTRADICTION ouverte #{cid} avec une valeur précédente" if cid else ""))
