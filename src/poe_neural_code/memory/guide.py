"""Guide du système d'économie de tokens d'Eclipse, injecté dans le prompt système de TOUS les fournisseurs.

Il décrit les mécanismes réels (aucune promesse inventée) :
- mémoire persistante du dossier (items structurés, résumés, archives) dont une sélection est réinjectée à chaque tour ;
- recherche puis chargement ciblé d'un passage (memory_search -> memory_load), avec cache de passages ;
- notes structurées (memory_note) qui remplacent la relecture d'échanges entiers ;
- lecture partielle des fichiers (read_file start/end) et recherche préalable (search_files) ;
- compactage automatique du fil (résumés vérifiables, originaux archivés et rechargeables).
"""

TOKEN_GUIDE = """## Eclipse token-saving system (use it: every token re-sent each turn costs the user)
- The project root is your working folder: create the files the user asks for there (with write_file), organised in sensible sub-folders.
- Project memory persists across conversations in this folder. The "memory" block in this prompt is only a small, relevant selection;
  everything else is archived and retrievable. Before re-reading large files or asking the user something again, call memory_search
  (cheap, returns refs) and then memory_load ONLY the passage you need (ref archive:N / item:N / summary:N).
- Record durable knowledge as soon as you learn it with memory_note (kind: goal, constraint, fact, hypothesis, decision, task, error, question;
  give the source; use "key" to avoid duplicates and "replaces" to update an item). A note is re-injected later for a few tokens instead of
  the whole exchange that produced it. Write notes for: decisions and their reason, file layout, commands that work, user preferences, errors fixed.
- Read narrowly: search_files first, then read_file with start/end line ranges. Never read a whole large file "to see"; never re-read a file
  you just wrote or that is unchanged.
- Prefer edit_file (small exact replacement) to rewriting a whole file with write_file.
- Keep command output small (head/tail, quiet flags, filtered greps).
- Older parts of this conversation are compacted automatically into summaries (originals stay archived and loadable): do not paste long
  content back into the chat; refer to files and memory refs instead.
- Keep todo_write up to date on multi-step work so the plan survives compaction."""


def delegated_guide(memory_tools: bool, prefix: str = "eclipse_") -> str:
    """Version pour un agent délégué (OpenCode…), qui garde ses propres outils de fichiers."""
    lines = ["(Consignes d'Eclipse, l'environnement qui vous lance : économisez les tokens.)",
             "- Le dossier courant est votre dossier de travail : créez-y les fichiers demandés.",
             "- Lisez de façon ciblée (recherche d'abord, plages de lignes ensuite), gardez les sorties de commandes courtes."]
    if memory_tools:
        lines += [f"- Mémoire persistante du projet disponible via les outils {prefix}memory_search (cherche, renvoie des références), "
                  f"{prefix}memory_load (charge un seul passage) et {prefix}memory_note (enregistre décision, fait, contrainte, erreur corrigée…, avec la source).",
                  f"- Avant de relire de gros fichiers ou de redemander quelque chose, utilisez {prefix}memory_search ; "
                  f"enregistrez avec {prefix}memory_note ce qui doit être retenu pour les prochaines conversations."]
    return "\n".join(lines)
