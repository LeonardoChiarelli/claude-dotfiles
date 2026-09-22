---
name: codex-claude-integration-status
description: Plano Codex+Claude fases 0-2 feitas em 2026-09-21; gate de merge = validação local (sem GitHub Actions); 8 PRs Fase 0 pendentes + coding-drills aguardando review
metadata: 
  node_type: memory
  type: project
  originSessionId: bf0a5bbb-cdbf-422a-9ac2-3d02fae5b518
  modified: 2026-09-22T01:11:53.197Z
---

Plano: `~/Downloads/plano-integracao-codex-claude.md`. Estado em 2026-09-21:

- **Fase 1 (Claude→Codex):** plugin `codex@openai-codex` v1.0.6 fixado na tag auditada. `permissions.deny` bloqueia `Agent(codex:codex-rescue)` e `codex-companion.mjs task --write`. Review via `node <plugin>/scripts/codex-companion.mjs review --base <ref> --scope branch`.
- **Fase 2 (Codex→Claude):** repo privado `LeonardoChiarelli/ai-bridge` em `Documents/Business/personal/ai-bridge` (PR #1 mesclado). Skill Codex `~/.agents/skills/consult-claude`. Aceitação passou via `codex exec`. Log em `~/.ai-bridge/logs/` (arquivo nomeado por data UTC).
- **Fase 0:** 18 repos com AGENTS.md fonte + CLAUDE.md `@AGENTS.md`. Mesclados (9): cnpj-alfanumerico, ofx-br, colecao-ia-pratica, Cert-AI, maquina-clientes-template, open-finance-control, hairmatch, roomglow, setupscore. coding-drills #1 aberto: proteção exige 1 review aprovado (usuário decide sobre --admin). 8 PRs abertos que o Actions não rodou por billing (Chiarelli-Labs, clicka-avatar, Connecting, Conciliador, Eventtita, matheus-invest, project-templates, use-zanotti); worktrees em Documents/Business/worktrees/ai-base/.
- **Política (2026-09-21):** usuário não vai contratar GitHub Actions. Gate de merge = validação local do AGENTS.md; CI é informativo (falha real bloqueia; job não iniciado por billing não bloqueia). Aplicado em CLAUDE.md/AGENTS.md globais, /entrega e branch-promoter.
- git-promotion-guard libera push simples na main só para claude-dotfiles e Codex-dotfiles (fluxo do /sync-dotfiles).
- Revisão cruzada provou valor: o Codex achou 7 problemas reais no ai-bridge que 2 revisões Opus deixaram passar.

**Why:** métricas de 30 dias decidem se o fluxo bilateral continua (plano, seção "Métricas").
**How to apply:** os 8 PRs pendentes podem ser promovidos pela política de validação local (diff só .md), removendo o worktree antes do merge. Etapa B do ai-bridge (reproduzir testes) só após 10 consultas sem incidente (ADR-002). Relacionado: [[model-roles-entrega]], [[windows-shell-path-gotchas]].
