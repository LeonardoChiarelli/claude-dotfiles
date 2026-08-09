#!/usr/bin/env bash
# Claude Code dotfiles bootstrap — macOS / Linux
#   git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git ~/dotfiles/claude
#   bash ~/dotfiles/claude/install.sh [--dry-run]
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

command -v git  >/dev/null || { echo "[error] git is required"; exit 1; }
command -v node >/dev/null || { echo "[error] Node.js is required: https://nodejs.org"; exit 1; }

echo "==> Claude dotfiles bootstrap"
echo "    Dotfiles: $DOTFILES_DIR"
echo "    Target:   $CLAUDE_DIR"
echo ""

# ── 1. Config, memory, MCP — manifest-driven ──────────────────────────────
node "$DOTFILES_DIR/tools/dotfiles.mjs" install $DRY
[ -n "$DRY" ] && { echo "[dry-run] stopping before toolchain install"; exit 0; }

# ── 2. jq (needed by the rtk hook) ────────────────────────────────────────
pkg_install() {
  local pkg="$1"
  if command -v brew &>/dev/null;    then brew install "$pkg"; return $?; fi
  if command -v apt-get &>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y "$pkg"; return $?; fi
  if command -v dnf &>/dev/null;     then sudo dnf install -y "$pkg"; return $?; fi
  if command -v pacman &>/dev/null;  then sudo pacman -S --noconfirm "$pkg"; return $?; fi
  return 1
}
echo ""
echo "==> Installing jq..."
if command -v jq &>/dev/null; then
  echo "[skip] jq already installed"
elif pkg_install jq; then
  echo "[ok]   jq installed"
else
  echo "[warn] no supported package manager — install jq manually: https://jqlang.github.io/jq/download/"
fi

# ── 3. rtk (token-efficient CLI proxy) ────────────────────────────────────
echo ""
echo "==> Installing rtk..."
if command -v rtk &>/dev/null; then
  echo "[skip] rtk already installed"
elif command -v brew &>/dev/null && brew install rtk 2>/dev/null; then
  echo "[ok]   rtk installed via Homebrew"
elif command -v cargo &>/dev/null && cargo install rtk; then
  echo "[ok]   rtk installed via cargo"
else
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  echo "[warn] rtk installs to ~/.local/bin — ensure it is on your PATH"
fi

# ── 4. rtk PreToolUse hook in settings.local.json (machine-local) ─────────
LOCAL_SETTINGS="$CLAUDE_DIR/settings.local.json"
if [ ! -f "$LOCAL_SETTINGS" ]; then
  cat > "$LOCAL_SETTINGS" <<EOF
{
  "permissions": { "allow": [] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bash $CLAUDE_DIR/hooks/rtk-rewrite.sh" }
        ]
      }
    ]
  }
}
EOF
  echo "[ok]   settings.local.json created with rtk PreToolUse hook"
else
  if grep -q rtk-rewrite "$LOCAL_SETTINGS"; then
    echo "[skip] rtk hook already wired in settings.local.json"
  else
    echo "[warn] settings.local.json exists without the rtk hook — see README for the JSON snippet"
  fi
fi

echo ""
echo "==> Done. Final steps:"
echo "    1. Open Claude Code once — plugins in settings.json auto-install."
echo "    2. MCP servers with OAuth (sentry, neon, context7) authenticate on first use."
echo "    3. Check output above for any [warn] lines."
