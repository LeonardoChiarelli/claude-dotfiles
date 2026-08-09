---
name: prefer-orchestrator-routing
description: "For multi-domain work, route via orchestrator pattern (named custom agents) instead of the subagent-driven-development skill"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aa73456f-edc0-4f9c-b6b2-5afaffabcf21
---

For multi-domain / multi-task work, prefer the orchestrator routing pattern over the `superpowers:subagent-driven-development` skill.

The subagent-driven skill hardcodes `Task tool (general-purpose):` in all three prompt templates (implementer, spec-reviewer, code-quality-reviewer), so it never uses the user's custom agents in `~/.claude/agents/` (`code-reviewer`, `qa-runner`, `security-reviewer`, `db-migrator`, etc.).

**Why:** The user wants their tuned custom agents (with project-specific system prompts and outcome rubrics) to actually run, not blank general-purpose agents. The orchestrator (`~/.claude/agents/orchestrator.md`) already dispatches sub-agents by name.

**How to apply:** Default to **Form B** — the main thread itself decomposes the task and dispatches named agents directly via `Task` (e.g. `subagent_type: code-reviewer`). Avoids nested-subagent depth limits. Use **Form A** (dispatch the `orchestrator` agent, which then sub-dispatches) only when preserving the main thread's context for heavy coordination matters; watch for nesting falling back to general-purpose. Do NOT edit the superpowers plugin templates — they live in plugin cache and get overwritten on update.
