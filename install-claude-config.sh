#!/usr/bin/env bash
# Configure Claude Code (~/.claude): subagents, CLAUDE.md, plugins and mods, the rtk hook,
# and a few settings. Run by install.sh; safe to run on its own and to run again.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SRC="$HOME/src"
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
mkdir -p "$CLAUDE_DIR/agents" "$SRC"

say "Subagents -> $CLAUDE_DIR/agents"
for f in "$REPO"/claude/agents/*.md; do
  sed "s|__HOME__|$HOME|g" "$f" > "$CLAUDE_DIR/agents/$(basename "$f")"
  echo "  $(basename "$f" .md)"
done

say "CLAUDE.md (orchestration rules)"
MARK="## Agent orchestration"
if ! grep -qsF "$MARK" "$CLAUDE_DIR/CLAUDE.md"; then
  { [ -s "$CLAUDE_DIR/CLAUDE.md" ] && echo; cat "$REPO/claude/CLAUDE.md"; } >> "$CLAUDE_DIR/CLAUDE.md"
  echo "  added"
else
  echo "  already there"
fi

say "Plugin marketplaces and plugins"
added() { claude plugin marketplace list 2>/dev/null | grep -q "$1"; }
added claude-community || claude plugin marketplace add anthropics/claude-plugins-community

if [ ! -d "$SRC/claude-code-playground" ]; then
  git clone -q --depth 1 https://github.com/anthropics/claude-code-playground.git "$SRC/claude-code-playground"
fi
added claude-code-playground-mods || claude plugin marketplace add "$SRC/claude-code-playground/claude-code/mods"

# This repo's own mods (agent-meter) as a local marketplace.
added my-mods || claude plugin marketplace add "$REPO/mods"
claude plugin marketplace update my-mods >/dev/null 2>&1 || true

for p in html-plan@claude-community eli5@claude-community \
         blast-radius@claude-code-playground-mods agent-meter@my-mods; do
  claude plugin install "$p" --scope user
done

say "rtk hook (PreToolUse on Bash)"
rtk init -g --auto-patch

say "Settings (advisor model, thinking, theme)"
python3 - "$CLAUDE_DIR/settings.json" <<'EOF'
import json, os, sys
path = sys.argv[1]
s = json.load(open(path)) if os.path.exists(path) else {}
s.update({"advisorModel": "opus", "alwaysThinkingEnabled": True, "themeId": 1})
json.dump(s, open(path, "w"), indent=2)
print("  advisorModel=opus, alwaysThinkingEnabled=true")
EOF

echo
echo "Restart Claude Code (or start it with: hclaude) to load the agents, plugins and hook."
