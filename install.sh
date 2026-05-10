#!/usr/bin/env bash
# Claude Code dotfiles bootstrap
# Run this on any new machine:
#   git clone git@github.com:LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
#   bash ~/dotfiles/claude/install.sh

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "==> Claude dotfiles bootstrap"
echo "    Dotfiles: $DOTFILES_DIR"
echo "    Target:   $CLAUDE_DIR"
echo ""

# ── 1. Create ~/.claude if missing ────────────────────────────────────────
mkdir -p "$CLAUDE_DIR"

# ── 2. Symlink skills ─────────────────────────────────────────────────────
if [ -L "$CLAUDE_DIR/skills" ]; then
  echo "[skip] ~/.claude/skills already symlinked"
elif [ -d "$CLAUDE_DIR/skills" ]; then
  echo "[warn] ~/.claude/skills is a real directory — backing up to ~/.claude/skills.bak"
  mv "$CLAUDE_DIR/skills" "$CLAUDE_DIR/skills.bak"
  ln -s "$DOTFILES_DIR/skills" "$CLAUDE_DIR/skills"
  echo "[ok]   ~/.claude/skills → $DOTFILES_DIR/skills"
else
  ln -s "$DOTFILES_DIR/skills" "$CLAUDE_DIR/skills"
  echo "[ok]   ~/.claude/skills → $DOTFILES_DIR/skills"
fi

# ── 3. Symlink CLAUDE.md ──────────────────────────────────────────────────
if [ -L "$CLAUDE_DIR/CLAUDE.md" ]; then
  echo "[skip] ~/.claude/CLAUDE.md already symlinked"
elif [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  echo "[warn] ~/.claude/CLAUDE.md exists — backing up to ~/.claude/CLAUDE.md.bak"
  mv "$CLAUDE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md.bak"
  ln -s "$DOTFILES_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  echo "[ok]   ~/.claude/CLAUDE.md → $DOTFILES_DIR/CLAUDE.md"
else
  ln -s "$DOTFILES_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  echo "[ok]   ~/.claude/CLAUDE.md → $DOTFILES_DIR/CLAUDE.md"
fi

# ── 4. Merge settings.json (does NOT overwrite settings.local.json) ───────
SETTINGS_TARGET="$CLAUDE_DIR/settings.json"
SETTINGS_SRC="$DOTFILES_DIR/settings.json"
if [ ! -f "$SETTINGS_TARGET" ]; then
  cp "$SETTINGS_SRC" "$SETTINGS_TARGET"
  echo "[ok]   ~/.claude/settings.json created from template"
else
  echo "[skip] ~/.claude/settings.json already exists — not overwriting"
  echo "       Review $SETTINGS_SRC and merge manually if needed"
fi

# ── 5. Install rtk (token-efficient CLI proxy) ────────────────────────────
echo ""
echo "==> Installing rtk..."
if command -v rtk &>/dev/null; then
  echo "[skip] rtk already installed: $(rtk --version 2>/dev/null || echo 'unknown version')"
elif command -v brew &>/dev/null; then
  brew install rtk
  echo "[ok]   rtk installed via Homebrew"
else
  echo "[warn] Homebrew not found. Install rtk manually:"
  echo "       curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh"
  echo "       Then add ~/.local/bin to PATH in your shell profile"
fi

# ── 6. Configure rtk hook in settings.local.json ─────────────────────────
RTK_BIN="$(command -v rtk 2>/dev/null || echo '')"
LOCAL_SETTINGS="$CLAUDE_DIR/settings.local.json"

if [ -n "$RTK_BIN" ]; then
  if [ ! -f "$LOCAL_SETTINGS" ]; then
    cat > "$LOCAL_SETTINGS" <<EOF
{
  "permissions": {
    "allow": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$RTK_BIN rewrite"
          }
        ]
      }
    ]
  }
}
EOF
    echo "[ok]   ~/.claude/settings.local.json created with rtk PreToolUse hook"
  else
    echo "[skip] ~/.claude/settings.local.json already exists"
    echo "       Add rtk hook manually — see README.md for the JSON snippet"
  fi
fi

# ── 7. Install caveman (output compression plugin) ────────────────────────
echo ""
echo "==> Installing caveman..."
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash
echo "[ok]   caveman installed"

# ── 8. Manual steps reminder ─────────────────────────────────────────────
echo ""
echo "==> Done! One manual step remaining:"
echo ""
echo "    Install context-mode plugin (run inside Claude Code):"
echo "      /plugin marketplace add mksglu/context-mode"
echo "      /plugin install context-mode@context-mode"
echo "    Then restart Claude Code."
echo ""
echo "==> Summary of what was installed:"
echo "    • ~/.claude/skills  → symlinked to $DOTFILES_DIR/skills"
echo "    • ~/.claude/CLAUDE.md → symlinked to $DOTFILES_DIR/CLAUDE.md"
echo "    • rtk (CLI token proxy, 60-90% savings)"
echo "    • caveman (output compression, ~75% savings)"
echo "    • context-mode: install manually in Claude Code (see above)"
