#!/usr/bin/env bash
# Claude Code dotfiles bootstrap — macOS / Linux
# Run this on any new Unix machine:
#   git clone git@github.com:LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
#   bash ~/dotfiles/claude/install.sh
#
# On Windows, use the PowerShell counterpart instead:
#   pwsh -File ~/dotfiles/claude/install.ps1

set -euo pipefail

# Pick an available package manager for jq / rtk fallbacks.
pkg_install() {
  local pkg="$1"
  if command -v brew &>/dev/null;    then brew install "$pkg"; return $?; fi
  if command -v apt-get &>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y "$pkg"; return $?; fi
  if command -v dnf &>/dev/null;     then sudo dnf install -y "$pkg"; return $?; fi
  if command -v pacman &>/dev/null;  then sudo pacman -S --noconfirm "$pkg"; return $?; fi
  return 1
}

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "==> Claude dotfiles bootstrap"
echo "    Dotfiles: $DOTFILES_DIR"
echo "    Target:   $CLAUDE_DIR"
echo ""

# ── 1. Create ~/.claude if missing ────────────────────────────────────────
mkdir -p "$CLAUDE_DIR"

# ── 2. Sync skills (individual copies — preserves pre-existing symlinks) ──
mkdir -p "$CLAUDE_DIR/skills"
for skill_dir in "$DOTFILES_DIR/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  target="$CLAUDE_DIR/skills/$skill_name"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "[skip] ~/.claude/skills/$skill_name already exists"
  else
    cp -r "$skill_dir" "$target"
    echo "[ok]   ~/.claude/skills/$skill_name installed"
  fi
done

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

# ── 5a. Install jq (needed by the rtk hook) ───────────────────────────────
echo ""
echo "==> Installing jq..."
if command -v jq &>/dev/null; then
  echo "[skip] jq already installed: $(jq --version 2>/dev/null)"
elif pkg_install jq; then
  echo "[ok]   jq installed"
else
  echo "[warn] No supported package manager found. Install jq manually:"
  echo "       https://jqlang.github.io/jq/download/"
fi

# ── 5b. Install rtk (token-efficient CLI proxy) ───────────────────────────
echo ""
echo "==> Installing rtk..."
if command -v rtk &>/dev/null; then
  echo "[skip] rtk already installed: $(rtk --version 2>/dev/null || echo 'unknown version')"
elif command -v brew &>/dev/null && brew install rtk 2>/dev/null; then
  echo "[ok]   rtk installed via Homebrew"
elif command -v cargo &>/dev/null && cargo install rtk; then
  echo "[ok]   rtk installed via cargo"
else
  echo "[warn] No package manager available for rtk — using the official installer:"
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  echo "[warn] rtk installs to ~/.local/bin — ensure that directory is on your PATH"
fi

# ── 6. Symlink rtk hook script ───────────────────────────────────────────
mkdir -p "$CLAUDE_DIR/hooks"
ln -sf "$DOTFILES_DIR/hooks/rtk-rewrite.sh" "$CLAUDE_DIR/hooks/rtk-rewrite.sh"
chmod +x "$DOTFILES_DIR/hooks/rtk-rewrite.sh"
echo "[ok]   ~/.claude/hooks/rtk-rewrite.sh → $DOTFILES_DIR/hooks/rtk-rewrite.sh"

# ── 7. Configure rtk hook in settings.local.json ─────────────────────────
LOCAL_SETTINGS="$CLAUDE_DIR/settings.local.json"

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
            "command": "bash $CLAUDE_DIR/hooks/rtk-rewrite.sh"
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
  echo "       Ensure the rtk hook is present — see README.md for the JSON snippet"
fi

# ── 8. Install caveman (output compression plugin) ────────────────────────
echo ""
echo "==> Installing caveman..."
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash
echo "[ok]   caveman installed"

# ── 9. Manual steps reminder ─────────────────────────────────────────────
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
