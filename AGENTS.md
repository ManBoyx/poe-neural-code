# Collaboration avec Claude Code

Dans une discussion Eclipse `/cg`, Eclipse orchestre tous les échanges. Exécute uniquement le rôle demandé par `/cg` et transmets-lui ton rapport directement.

Pour les changements de code dans Eclipse, réalise l’implémentation et les tests, puis demande automatiquement une relecture à Claude Code depuis la racine du dépôt. Dans la demande, précise l’objectif, les fichiers concernés et les tests effectués. Utilise une commande de cette forme :

```sh
claude -p --no-session-persistence --tools 'Read,Grep,Glob' --strict-mcp-config --mcp-config '{"mcpServers":{}}' -- 'Relis les changements Eclipse décrits ci-dessous. Tu es le relecteur final. Rends tes observations avec fichier et ligne, sans modifier le dépôt ni appeler Codex. …'
```

Si tu es déjà le relecteur d’un autre agent, rends directement tes observations. L’agent qui a commencé le travail reste responsable des modifications. Vérifie les observations du relecteur, corrige les problèmes confirmés et signale dans ton bilan si la relecture a échoué ou si l’utilisateur a demandé de la passer.
