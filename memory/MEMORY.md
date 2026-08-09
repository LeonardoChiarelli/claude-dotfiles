# memories
- [machine-migration-status](machine-migration-status.md) — migração lrchi→Leonardo 100% concluída (bundle removido, gh auth ok, rtk instalado)
- [claude-config-consolidation](claude-config-consolidation.md) — generic Claude config is user-global in ~/.claude; projects keep only project-specific bits; cleanup on branch chore/consolidate-claude-config (unmerged)
- [prefer-orchestrator-routing](prefer-orchestrator-routing.md) — route multi-domain work via orchestrator pattern (named agents), not subagent-driven skill (which hardcodes general-purpose)
- [claude-md-autoload-paths](claude-md-autoload-paths.md) — only root/local/global CLAUDE.md auto-load; .claude/CLAUDE.md, .claude/.agents, .mdc rules are ignored
- [engineering-pipeline-skills](engineering-pipeline-skills.md) — 7 fixed-scope spec→issues→entrega skills adapted from mattpocock/skills installed in ~/.claude/skills; needs per-repo /setup-engineering-pipeline; git-guardrails hook not yet wired
- [video-editor-toolkit](video-editor-toolkit.md) — toolkit pra editar vídeos com Claude Code (FFmpeg+HyperFrames+ASS, manifest Zod); spec+plano1 prontos, não implementado
- [claude-mem-marketing-skills-install](claude-mem-marketing-skills-install.md) — marketing-skills (45) instalado global user-scope; claude-mem@thedotmack desinstalado (estava quebrado)
- [nudge-project](nudge-project.md) — sistema local Windows de lembretes escalonados (Rust+Tauri); fase 1 implementada (66 testes), faltam verificações manuais e fases 2-5
- [ccusage-statusline](ccusage-statusline.md) — ccusage global wired na statusline (~/.claude/hooks/caveman-statusline.ps1) mostra contexto% e limite sessão (block 5h)
