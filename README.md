# claude-dotfiles

Claude Code global config — skills, CLAUDE.md, bootstrap script.

## Setup on a new machine

**macOS / Linux:**
```bash
git clone git@github.com:LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
bash ~/dotfiles/claude/install.sh
```

**Windows (PowerShell 7+):**
```powershell
git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git $HOME\dotfiles\claude
pwsh -File $HOME\dotfiles\claude\install.ps1
```

That's it. Both scripts do the same thing for their platform:
1. Link/copy `~/.claude/skills` and `~/.claude/CLAUDE.md` from this repo
   - Unix symlinks; Windows copies (symlinks need admin/Developer Mode) — re-run after `git pull` to refresh
2. Create or **merge** `~/.claude/settings.json` from the template (preserves existing keys)
3. Install `jq` + `rtk` (Homebrew/apt/dnf/pacman/cargo on Unix, winget/cargo on Windows) and configure the PreToolUse hook in `settings.local.json`
4. Install the `caveman` plugin for Claude Code
5. Print instructions for the `context-mode` plugin (requires Claude Code UI)

### Cross-platform notes
- The rtk hook (`hooks/rtk-rewrite.sh`) is a single Bash script used on every OS. On Windows it runs through **Git Bash**, so Git for Windows must be installed.
- `jq` and `rtk` are required for the hook to actually rewrite commands; if either is missing the hook degrades to a no-op (no errors).

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
├── install.sh          # bootstrap script (macOS / Linux)
├── install.ps1         # bootstrap script (Windows / PowerShell 7+)
├── settings.json       # template (no machine-specific paths)
│                       # settings.local.json lives per-machine, not versioned
├── CLAUDE.md           # global Claude instructions
├── hooks/
│   └── rtk-rewrite.sh  # rtk PreToolUse hook (Bash; runs via Git Bash on Windows)
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
