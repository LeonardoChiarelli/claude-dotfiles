# claude-dotfiles

Claude Code global config — skills, CLAUDE.md, bootstrap script.

## Setup on a new machine

```bash
git clone git@github.com:LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
bash ~/dotfiles/claude/install.sh
```

That's it. The script will:
1. Symlink `~/.claude/skills` and `~/.claude/CLAUDE.md` to this repo
2. Create `~/.claude/settings.json` from the template (skips if it already exists)
3. Install `rtk` via Homebrew and configure the PreToolUse hook in `settings.local.json`
4. Install `caveman` plugin for Claude Code
5. Print instructions for the `context-mode` plugin (requires Claude Code UI)

## Manual step after install

Inside Claude Code:
```
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```
Restart Claude Code after.

## What each tool does

| Tool | Benefit | Scope |
|------|---------|-------|
| `rtk` | 60-90% token reduction on CLI commands (ls, git, pytest...) | Hook-based, transparent |
| `caveman` | ~75% output token reduction, terse responses | Claude Code plugin |
| `context-mode` | 98% tool output reduction + session continuity via MCP | Claude Code plugin |

## File layout

```
claude-dotfiles/
├── install.sh          # bootstrap script
├── settings.json       # template (no machine-specific paths)
│                       # settings.local.json lives per-machine, not versioned
├── CLAUDE.md           # global Claude instructions
├── skills/
│   ├── find-skills/
│   ├── graphify/
│   └── caveman/        # populated after first install
└── .gitignore
```

## Adding skills

Drop the skill folder inside `skills/` and commit. All machines will get it on next `git pull`.

## Machine-specific permissions

Machine-specific `allow` permissions (e.g., venv paths) go in `~/.claude/settings.local.json`, which is gitignored. The versioned `settings.json` only contains portable settings (plugins, effortLevel, editorMode).
