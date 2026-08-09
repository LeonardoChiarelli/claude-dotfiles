---
name: machine-migration-status
description: Migração lrchi→Leonardo concluída (bundle removido, gh auth login feito)
metadata: 
  node_type: memory
  type: project
  originSessionId: 35f81f77-d35b-4e7c-b46e-ee007c0d151d
  modified: 2026-07-22T22:32:04.552Z
---

Migração da máquina antiga (user `lrchi`, host BOOK-1FGT34167L) para esta (user `Leonardo`), bundle em `C:\claude-mig` (2026-07-22).

**Concluído:** fases 1, 2a e 2b do `restore-compat.ps1`/`FINISH-RESTORE.cmd` (Documents, video-editor-toolkit, .claude-mem, .cursor, .config, .agents, .claude\, .claude.json — todos migrados/verificados); remap de paths/slug; instalados via winget: Git 2.55, Node LTS 24.18 (em `C:\Program Files\nodejs\node.exe`, caminho exato dos hooks), PowerShell 7.6 (pwsh, statusline), gh CLI 2.96, FFmpeg 8.1, jq 1.8; `git config --global` user.name/email setado; `settings.local.json` com paths lrchi corrigidos. `C:\claude-mig\` e `Documents\claude-migration-bundle.zip` removidos em 2026-07-22 (migração confirmada completa pelo usuário).

**Pendente:** nada. `rtk` v0.43.0 instalado em 2026-07-22 (release Windows msvc, VC++ Redist + ripgrep via winget como pré-requisitos; hook migrado de `rtk-rewrite.sh` legado pra `rtk hook claude` nativo em `settings.local.json`). Plugin `claude-mem@thedotmack` (veio `false` do bundle, cache vazio, worker morto) foi desinstalado por completo a pedido do usuário — ver [[claude-mem-marketing-skills-install]].

Sobras de `lrchi` só em transcripts históricos (`projects\*.jsonl`), cosmético.
