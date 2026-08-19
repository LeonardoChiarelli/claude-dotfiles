---
name: claude-dotfiles-bootstrap
description: repo claude-dotfiles agora é bootstrap completo (manifest-driven) com /sync-dotfiles + hook de drift; máquina nova = clone + install.ps1
metadata: 
  node_type: memory
  type: project
  originSessionId: c0e9fee2-852d-4ee5-b2c6-6e1e3e435a68
  modified: 2026-08-09T04:09:21.132Z
---

Desde 2026-08-09 o repo `LeonardoChiarelli/claude-dotfiles` (clone em `~/dotfiles/claude`) é o bootstrap completo da config do Claude Code: `manifest.json` dirige `tools/dotfiles.mjs` (subcomandos `export` / `install` / `scan` / `roundtrip`), `home/` espelha `~/.claude` (settings.json tokenizado com `{{CLAUDE_HOME}}`/`{{NODE}}`, nas formas backslash E forward-slash), `memory/` espelha a memória persistente, `mcp.json` lista MCP servers sem segredos (env + headers + args redigidos). Plugins viajam dentro do próprio settings.json (`enabledPlugins` + `extraKnownMarketplaces`) — não existe manifest separado de plugins.

Fluxo dia a dia: mudou skill/hook/agent/settings → hook `dotfiles-drift.mjs` (PostToolUse, 1x por sessão) lembra → rodar skill `/sync-dotfiles` (export → scan de segredos → diff → commit → push; nunca force). Máquina nova: clone + `install.ps1`/`install.sh` (`-DryRun`/`--dry-run` disponível).

Follow-ups menores conhecidos (review apontou, não corrigidos): statusLine usa `pwsh` (quebra em Mac/Linux); paths pessoais hardcoded dentro de skills (novo-projeto-chiarelli, video-editor refs); allowlist do scan avalia a linha inteira; quoting do heredoc do hook rtk em `install.sh` com home contendo espaço. Relacionado: [[machine-migration-status]], [[validate-manifest-hook-gotcha]].
