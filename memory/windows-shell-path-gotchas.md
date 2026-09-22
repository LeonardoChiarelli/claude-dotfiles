---
name: windows-shell-path-gotchas
description: "ctx_execute shell passa caminho MSYS (~ vira /c/...) literal pro git → worktree criado em C:\\c\\Users\\...; rtk reescreve `npm run lint`"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf0a5bbb-cdbf-422a-9ac2-3d02fae5b518
  modified: 2026-09-22T00:33:41.453Z
---

- `ctx_execute(language: shell)` expande `~` para `/c/Users/...`; o `git.exe` nativo recebe isso literal e cria o caminho `C:\c\Users\...`. Em 2026-09-21 isso espalhou 18 worktrees (corrigido com `git worktree move`).
- O proxy `rtk` reescreve `npm run lint` e devolve saída de "ESLint" mesmo em repo sem ESLint. Para verificar lint de verdade, rodar o comando cru do script.

**Why:** os dois geram resultado errado sem erro visível.
**How to apply:** para comandos git/node que recebem caminho, usar a tool Bash com caminho estilo `C:/Users/...` explícito, nunca `~` dentro do ctx_execute. Desconfiar de saída de lint via rtk. Relacionado: [[model-roles-entrega]].
- O RTK também reescreve `pytest`/`ruff`/`grep` e já devolveu "No tests collected" e exit falso. Em 2026-09-21 `pytest`, `ruff` e `npm run lint` foram excluídos em `%APPDATA%/rtk/config.toml` (`[hooks] exclude_commands`). `grep` continua sendo reescrito.
- context-mode injeta instruções de tools MCP em subagents que não têm essas tools; os agentes de papel denunciam isso como "prompt injection". É inofensivo.
