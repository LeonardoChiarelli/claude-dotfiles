---
name: codex-dotfiles-repo
description: "config do Codex tem repo próprio (LeonardoChiarelli/Codex-dotfiles, clone em ~/dotfiles/Codex); /sync-dotfiles cobre os dois numa rodada só desde 2026-08-19"
metadata: 
  node_type: memory
  type: project
  originSessionId: 55eb6e52-dd91-41e7-a0e3-2263a4e5b087
  modified: 2026-08-19T19:39:20.649Z
---

São **dois** repos de dotfiles, não um. Desde o commit `f171db0` a skill `/sync-dotfiles` cobre os dois numa rodada só.

| repo | clone | escopo |
|---|---|---|
| `LeonardoChiarelli/claude-dotfiles` (público) | `~/dotfiles/claude` | `~/.claude`: CLAUDE.md, RTK.md, settings.json, keybindings.json, skills, agents, hooks, outcomes, scripts + `memory/` + `mcp.json` |
| `LeonardoChiarelli/Codex-dotfiles` (privado) | `~/dotfiles/Codex` | `~/.codex`: AGENTS.md, RTK.md, CLAUDE_MIGRATION.md, hooks.json, hooks, agents, outcomes + `config.toml` sanitizado + `~/.agents/skills` |

Os dois usam `node tools/dotfiles.mjs export|scan|install`, mas os manifests têm formatos diferentes (o do Codex é `schemaVersion: 1` com blocos `codex`/`skills`; o do Claude é uma lista `include` chapada).

**Why:** os manifests têm formatos diferentes, então um export manual do Codex usa flags diferentes do Claude. E por muito tempo `/sync-dotfiles` cobria só metade.

**How to apply:** `/sync-dotfiles` já roda os dois. Export manual do Codex: `node ~/dotfiles/Codex/tools/dotfiles.mjs export && node ~/dotfiles/Codex/tools/dotfiles.mjs scan`. O `config.toml` exportado é sanitizado por `portableConfig()`: allowlist de seções (`PORTABLE_SECTIONS`) + allowlist de chaves de raiz (`PORTABLE_ROOT_KEYS`). Ele **exclui de propósito** `sandbox_mode`, além de `auth.json`, `[projects.*]` (trust levels) e o path do `notify`. Chave de config nova na raiz do `config.toml` só viaja se entrar em `PORTABLE_ROOT_KEYS`, senão some calada.

Relacionado: [[claude-dotfiles-bootstrap]], [[vercel-cli-detect-windows-patch]].
