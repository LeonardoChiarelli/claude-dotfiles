---
name: claude-md-autoload-paths
description: Which CLAUDE.md / .claude paths Claude Code actually auto-loads vs silently ignores
metadata: 
  node_type: memory
  type: reference
  originSessionId: 879077d5-27b5-49c8-8dca-80b59038ac1c
---

Claude Code auto-load rules (verified during the May 2026 .claude audit of Cert-AI / Chiarelli-Labs / Pain-to-Product):

- **Auto-loads:** root `CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`. Nested `CLAUDE.md` loads only on-demand when a session opens inside that subdir.
- **Does NOT auto-load:** `.claude/CLAUDE.md`. Putting authoritative commands/env/arch there means Claude never sees it. Fix: inline into root, or import via `@.claude/CLAUDE.md` in the root file (Claude Code supports `@path` imports relative to the importing file).
- **Agents:** `.claude/agents/**` recurses into subfolders (nested agents DO load). But `.claude/.agents/` (dotted) is NOT discovered — use dotted dirs only for non-subagent runtime LLM prompts.
- **Ignored entirely:** `.claude/rules/*.mdc` (Cursor format, `globs`/`alwaysApply` frontmatter). Keep those under `.cursor/rules/` only.
- **Hooks must be registered in `settings.json`** to run; an unregistered hook file is inert. Prefer `.mjs` hooks over `.sh` for win32 (POSIX `sh` no-ops without Git-Bash).

This mistake (authoritative content in `.claude/CLAUDE.md`) hit 2 of 3 audited projects. See [[claude-config-consolidation]].
