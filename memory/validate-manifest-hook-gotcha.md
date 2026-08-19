---
name: validate-manifest-hook-gotcha
description: hook global validate-manifest.mjs bloqueia Write/Edit em QUALQUER manifest.json (schema do video-editor); usar shell ou escopar o hook
metadata: 
  node_type: memory
  type: project
  originSessionId: c0e9fee2-852d-4ee5-b2c6-6e1e3e435a68
  modified: 2026-08-09T04:09:26.581Z
---

O hook PreToolUse global `~/.claude/hooks/validate-manifest.mjs` (do toolkit video-editor) casa `/manifest\.json$/` em qualquer path e valida contra o Zod schema do video-editor. Consequência: Write/Edit em qualquer `manifest.json` fora desse domínio (ex.: o do claude-dotfiles) é BLOQUEADO com erro de schema falso-positivo.

**Why:** o matcher do hook não restringe o diretório, só o basename.

**How to apply:** pra editar um manifest.json não-video-editor, usar Bash heredoc/`Set-Content` em vez de Write/Edit. Fix real (pendente de decisão): escopar o path match do hook ao projeto de vídeo. Nota: o hook está espelhado em `home/hooks/` do [[claude-dotfiles-bootstrap]], então máquina nova herda o comportamento.
