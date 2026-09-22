---
name: codex-claude-integration-status
description: Plano de integração Codex+Claude implementado em 2026-09-21 (fases 0-2); 15 PRs da Fase 0 abertos travados por billing do GitHub na org chiarelli-dev
metadata: 
  node_type: memory
  type: project
  originSessionId: bf0a5bbb-cdbf-422a-9ac2-3d02fae5b518
  modified: 2026-09-22T01:11:53.197Z
---

Plano: `~/Downloads/plano-integracao-codex-claude.md`. Estado em 2026-09-21:

- **Fase 1 (Claude→Codex):** plugin `codex@openai-codex` v1.0.6 fixado na tag auditada. `permissions.deny` bloqueia `Agent(codex:codex-rescue)` e `codex-companion.mjs task --write`. Review via `node <plugin>/scripts/codex-companion.mjs review --base <ref> --scope branch`.
- **Fase 2 (Codex→Claude):** repo privado `LeonardoChiarelli/ai-bridge` em `Documents/Business/personal/ai-bridge` (PR #1 mesclado). Skill Codex `~/.agents/skills/consult-claude`. Aceitação passou via `codex exec`. Log em `~/.ai-bridge/logs/` (arquivo nomeado por data UTC).
- **Fase 0:** 18 repos com AGENTS.md fonte + CLAUDE.md `@AGENTS.md`; branch `chore/ai-base`, worktrees em `Documents/Business/worktrees/ai-base/`. Mesclados: cnpj-alfanumerico, ofx-br, colecao-ia-pratica. Os outros 15 PRs estão abertos: repos privados da org `chiarelli-dev` com Actions bloqueado por falha de pagamento/limite de gasto; repos sem CI param em `no_ci`.
- Revisão cruzada provou valor: o Codex achou 7 problemas reais no ai-bridge que 2 revisões Opus deixaram passar.

**Why:** métricas de 30 dias decidem se o fluxo bilateral continua (plano, seção "Métricas").
**How to apply:** depois que o billing for regularizado, reexecutar o CI dos PRs `chore/ai-base` e promover; remover os worktrees após o merge. Etapa B do ai-bridge (reproduzir testes) só após 10 consultas sem incidente (ADR-002). Relacionado: [[model-roles-entrega]], [[windows-shell-path-gotchas]].
