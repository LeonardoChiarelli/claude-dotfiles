# claude-dotfiles: full bootstrap + sync design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Turn `claude-dotfiles` into a complete bootstrap for the user's Claude Code setup: cloning this one repo and running the installer on a fresh machine reproduces the entire `~/.claude` configuration (skills, agents, hooks, outcomes, settings, plugins, MCP servers, persistent memory). A sync mechanism keeps the repo up to date when configuration changes on the machine.

## Scope

Everything ships in this repo:

- Core config: `CLAUDE.md`, `RTK.md`, `settings.json` (templated), `keybindings.json` (if present), `skills/`, `agents/`, `hooks/`, `outcomes/`
- Plugins: declared inside `settings.json` itself (`enabledPlugins` + `extraKnownMarketplaces`) — Claude Code auto-installs them on startup, so no separate manifest is needed
- MCP manifest (`mcp.json`): user-scope MCP servers, secrets stripped
- Persistent memory (`memory/`): mirror of `~/.claude/projects/<key>/memory/`

Out of scope: `settings.local.json` (machine-specific permissions), caches, telemetry, shell snapshots, session state, plugin cache contents.

## Architecture

Repo layout is a 1:1 mirror of `~/.claude` under `home/`, driven by a single `manifest.json` at the repo root. Installer and sync skill both read the same manifest: adding a new item to the bootstrap is one manifest line, no script changes.

```
claude-dotfiles/
├── manifest.json        # single source of truth: what syncs
├── home/                # 1:1 mirror of ~/.claude
│   ├── CLAUDE.md
│   ├── RTK.md
│   ├── settings.json    # templated ({{CLAUDE_HOME}}, {{NODE}})
│   ├── skills/          # includes sync-dotfiles skill itself
│   ├── agents/
│   ├── hooks/           # includes dotfiles-drift.mjs reminder hook
│   └── outcomes/
├── memory/              # persistent memory mirror
├── mcp.json             # MCP servers manifest, secrets stripped (generated)
├── install.ps1          # bootstrap: repo → ~/.claude (Windows)
├── install.sh           # bootstrap: repo → ~/.claude (macOS/Linux)
├── docs/superpowers/specs/  # design docs
└── README.md
```

Three executable components:

1. **`install.ps1` / `install.sh`** — fresh-machine bootstrap (repo → `~/.claude`)
2. **`/sync-dotfiles` skill** (lives at `home/skills/sync-dotfiles/`) — machine → repo export with diff, secret scan, commit, push
3. **Reminder hook** (`home/hooks/dotfiles-drift.mjs`, PostToolUse on `Edit|Write|MultiEdit`) — when a write touches `~/.claude` outside volatile dirs, warns once per session: "config changed, run /sync-dotfiles"

## Manifest and sanitization

```json
{
  "home": {
    "include": ["CLAUDE.md", "RTK.md", "settings.json", "keybindings.json",
                "skills/", "agents/", "hooks/", "outcomes/"],
    "exclude": ["**/node_modules/", "*.doctor-bak*", "settings.local.json"]
  },
  "templated": ["settings.json"]
}
```

- **Templated `settings.json`**: absolute paths in the repo copy become tokens (`{{CLAUDE_HOME}}`, `{{NODE}}`). Sync performs the inverse substitution (real path → token); install renders (token → this machine's paths). Deterministic in both directions.
- **`settings.local.json` is never versioned** (machine-specific permissions, as today).
- **Secret scan on sync**: regex pass (`key|token|secret|password|api[_-]?key` followed by a value) over the diff before committing; on match, abort and show the offending line. Memory files are included in the scan.
- Include entries missing on a machine (e.g., no `keybindings.json`) are skipped silently.

## Plugins, MCP, memory

- **Plugins**: `settings.json` already carries `enabledPlugins` and `extraKnownMarketplaces`; Claude Code fetches marketplaces and installs enabled plugins on startup. The installer only prints "open Claude Code once — plugins auto-install". Known limitation: marketplaces with `directory` source (e.g., `cowork-roles`) are not reproducible from GitHub; the installer warns and skips them.
- **`mcp.json`**: generated from user-scope `mcpServers` in `~/.claude.json` (currently context7, neon, sentry, playwright). Env values whose key matches the secret regex are replaced with `{{SECRET:<name>}}`. Install registers each via `claude mcp add-json`; OAuth-based servers authenticate on first use.
- **`memory/`**: mirror of `~/.claude/projects/<key>/memory/`. `<key>` derives from the machine's home dir (e.g., `C--Users-Leonardo`); install computes the destination key dynamically from the current home path, so a different username works. Install merges per file and never deletes files that exist only on the destination.

## Flows

**Fresh machine:** `git clone` → run installer → copy per manifest, render `settings.json` from template, `npm install` in `hooks/` (a `package.json` lives there), install `rtk` + `jq` (current installer logic kept), register marketplaces + plugins, register MCP servers, copy memory. `--dry-run` / `-DryRun` prints the plan without executing.

**Day to day:** edit a skill/hook/agent → reminder hook fires once per session → run `/sync-dotfiles` → copy per manifest (home → repo), regenerate `plugins.json` / `mcp.json`, sanitize `settings.json`, show summarized diff, secret scan, commit, push. Changes made outside a session (e.g., plugin installed via CLI) are picked up on the next sync because export always reads current state.

## Error handling

- Sync with no local clone: skill clones to `~/dotfiles/claude` (path configurable via `CLAUDE_DOTFILES_DIR` env var).
- Push conflict: skill stops and reports; never force-pushes.
- Install over existing config: back up (`settings.json.bak`) before overwriting; memory merges per file.
- Secret scan hit: abort commit, show line, wait for user.

## Testing

**Round-trip test**: run sync → run install with `CLAUDE_HOME` pointed at a temp dir → diff temp dir against real `~/.claude` must be empty (modulo sanitized tokens). Validates both scripts in one pass. Installer `--dry-run` used for smoke checks on the real home dir.

## Decisions log

- Sync mechanism: skill + reminder hook chosen over symlink/junction layout (fragile on Windows) and over full auto-commit hook (noisy, secret-leak risk without review).
- Repo layout: mirror + manifest chosen over curated hardcoded layout (avoids triple maintenance in install.sh + install.ps1 + skill).
- Scope: user opted to include everything, including persistent memory and MCP/plugin manifests.
- `plugins.json` dropped during planning: `settings.json` already declares plugins (`enabledPlugins` + `extraKnownMarketplaces`) and Claude Code auto-installs from it — a separate manifest would duplicate state (YAGNI).
