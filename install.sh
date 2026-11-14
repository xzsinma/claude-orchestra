#!/usr/bin/env sh
# Installs the orchestra skill and its two subagents into your Claude Code user folder.
# Usage: ./install.sh [--force] [--dry-run]     (CLAUDE_DIR overrides ~/.claude)
set -eu
FORCE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=${CLAUDE_DIR:-"$HOME/.claude"}

copy() {
  if [ -e "$2" ] && [ "$FORCE" -ne 1 ]; then echo "skip   $2 (exists; use --force to overwrite)"; return; fi
  echo "copy   $2"
  [ "$DRY" -eq 1 ] && return
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
}

copy "$SRC/skills/orchestra/SKILL.md" "$DEST/skills/orchestra/SKILL.md"
copy "$SRC/agents/junior-haiku.md"    "$DEST/agents/junior-haiku.md"
copy "$SRC/agents/senior-opus.md"     "$DEST/agents/senior-opus.md"
echo "Done. Start a new Claude Code session to load the skill and agents."
