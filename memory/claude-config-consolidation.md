---
name: claude-config-consolidation
description: "How the user's Claude Code config is split between user-global ~/.claude and per-project .claude"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3068c308-fbc5-4624-9f51-b7a3c78e99d0
---

On 2026-05-28 the user's Claude Code setup was consolidated. **Generic, reusable config lives user-global in `~/.claude`; only project-specific config stays in each repo's `.claude`.**

User-global `~/.claude`:
- `agents/` — 11 generic subagents (orchestrator, code-reviewer, qa-runner, security-reviewer, db-migrator, docs-writer, perf-auditor, devops-automator, i18n-checker, lp-auditor, email-template-tester), merged from the two projects and made project-agnostic.
- `outcomes/` — baseline rubrics: code-review, bug-fix, feature, refactor.
- `skills/` — added remotion-best-practices, stripe-best-practices, stripe-projects, upgrade-stripe (plus existing graphify, caveman*, etc.). Superpowers skills come from the plugin, not copied per-project.
- `hooks/` — `guard-edits.mjs` (PreToolUse: blocks `.env` edits) + `check-emdash.mjs` (PostToolUse: pt-BR em-dash copy rule). Wired in `~/.claude/settings.json` on `Edit|Write|MultiEdit`.
- MCP user-scope servers added to `~/.claude.json`: context7, neon, sentry (http) + playwright (stdio).
- `CLAUDE.md` expanded with shared house rules (agent roster, outcome rubrics, pt-BR copy, security `<DADOS_EXTERNOS>`, default stack, Drizzle migration flow, memory hygiene).

Per-project `.claude` keeps only: project `CLAUDE.md`, `memory/*`, domain-specific agents (Cert-AI: ai-pipeline-auditor, payment-flow-checker, test-writer; Chiarelli: prospect-intelligence, engagement-reply-drafter, stripe-flow-reviewer, plus `.claude/.agents/` runtime business prompts), project-specific outcomes, and project skills (Chiarelli: create-migration, new-section). Cert-AI keeps its richer project hooks (guard-edits with import-boundary rules, post-edit with eslint --fix); Chiarelli's hooks+settings were removed since the global ones cover them.

Cleanup landed on `main` in both Cert-AI and Chiarelli-Labs (the `chore/consolidate-claude-config` branches are stale/superseded — only unique content is the now-removed `.mcp.json`). On 2026-05-28 the redundant project-scope `.mcp.json` files (Cert-AI: neon+sentry; Chiarelli: context7+neon) were deleted and committed+pushed to main (Cert-AI `9e5976b`, Chiarelli `68ac64c`); both projects now inherit MCP servers from user-global `~/.claude.json` (superset: context7, neon, sentry, playwright), matching Pain-to-Product which never had a project `.mcp.json`.

Pain-to-Product is a DIFFERENT, mature setup (813 commits) — NOT the Cert/Chiarelli monorepo template. Stack: Python FastAPI (`app/`) + Next.js 14 (`web/`), LiteLLM (not LLMProvider). Its `.claude` is a bespoke "virtual company" mirrored from `.cursor/`: 32 agents in team subdirs (engineering/executive/growth/marketing/mobile/security) + own root agents (orchestrator references the virtual company, code-reviewer, qa-runner, lp-auditoria, qa-varredura, rapid-prototyper), `/opsx-*` commands, `.mdc` Cursor rules, `hooks/session-context.sh`, and real project memory. The Cert/Chiarelli consolidation does NOT apply to it — its agents are bespoke, kept as-is. It still benefits automatically from the new user-global extra agents/skills/MCP/hooks (project agents shadow user agents by name where they overlap). Only optional cleanup: the 14 redundant superpowers skill stub files in `.claude/skills/` (covered by the plugin), left untouched.

The remotion-best-practices skill at `~/.claude/skills/` was genericized (removed CertAI/@certai specifics) on 2026-05-28.

New user-global agents/skills/MCP/hooks only take effect in a NEW Claude Code session.
