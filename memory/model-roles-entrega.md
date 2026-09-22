---
name: model-roles-entrega
description: "Papéis por modelo (Fable/Opus/Sonnet/Haiku ↔ Astra/Sol/Terra/Luna) + skill /entrega + git-promotion-guard, configurados em 2026-09-21"
metadata: 
  node_type: memory
  type: project
  originSessionId: bf0a5bbb-cdbf-422a-9ac2-3d02fae5b518
  modified: 2026-09-22T00:20:56.356Z
---

Em 2026-09-21 configurei nos dois harnesses (global) o fluxo de papéis pedido pelo usuário, como passo 1 do plano de integração Codex+Claude (`~/Downloads/plano-integracao-codex-claude.md`).

- Sessão principal organiza: Claude `model: fable`, Codex `gpt-6-astra` high. Subagentes: `implementer` (Sonnet/Terra), `slice-reviewer` (Opus/Sol), `branch-promoter` (Haiku/Luna). Os 17 especialistas ganharam `model` no mesmo esquema de tiers.
- Skill `/entrega` em `~/.claude/skills/entrega` e `~/.agents/skills/entrega`.
- Usuário escolheu **merge automático com CI verde** (squash). Sem CI → promotor para.
- `git-promotion-guard.mjs` (+ teste 27 casos) ligado em Bash|PowerShell (Claude) e Bash (Codex). Substitui o `block-dangerous-git.mjs` do git-guardrails, que bloqueia todo push.
- Backups em `~/.claude/backups/pre-roles-20260921-211713` e `~/.codex/backups/pre-roles-20260921-211713`.

**Why:** usuário quer delegação automática por papel; pesquisa mostrou que router aprendido não compensa (ver conversa), então roteamento é por regra/papel.
**How to apply:** fases 1 e 2 do plano (bridge Claude↔Codex via `claude -p`/`codex exec`) ainda pendentes; router aprendido só após 30 dias de métricas. Relacionado: [[engineering-pipeline-skills]], [[prefer-orchestrator-routing]].
