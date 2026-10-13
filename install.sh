#!/usr/bin/env bash
# Rebuild this Claude Code workstation on a fresh sbx sandbox (Ubuntu, arm64 or x86_64).
# Installs the tools, the virtual desktop (VNC), the browser and computer-use MCP servers,
# rtk and headroom, then runs install-claude-config.sh for agents, plugins, mods and settings.
#
#   ./install.sh               everything
#   ./install.sh --no-claude   tools and desktop only, leave ~/.claude alone
#   ./install.sh --no-desktop  skip the XFCE/VNC desktop and computer-use server
#
# Safe to run again: each step checks what is already there.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
SHARE="$HOME/.local/share/agent-desktop"

# Pinned versions (each was out at least two weeks when chosen).
PLAYWRIGHT_MCP_VERSION=0.0.82
MCP_PY_VERSION=1.30.0
RTK_VERSION=0.50.0
HEADROOM_VERSION=0.39.1
UV_VERSION=0.9.26

WITH_CLAUDE=1
WITH_DESKTOP=1
for arg in "$@"; do
  case "$arg" in
    --no-claude) WITH_CLAUDE=0 ;;
    --no-desktop) WITH_DESKTOP=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

mkdir -p "$BIN" "$SHARE"
case ":$PATH:" in *":$BIN:"*) ;; *) export PATH="$BIN:$PATH" ;; esac
if ! grep -qs 'HOME/.local/bin' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) RTK_ASSET="rtk-aarch64-unknown-linux-gnu.tar.gz" ;;
  x86_64|amd64) RTK_ASSET="rtk-x86_64-unknown-linux-musl.tar.gz" ;;
  *) echo "unsupported CPU: $ARCH" >&2; exit 1 ;;
esac

# --- System packages ---------------------------------------------------------
say "System packages"
PKGS=(git curl ca-certificates python3 nodejs npm)
if [ "$WITH_DESKTOP" = 1 ]; then
  PKGS+=(xfce4 xfce4-terminal dbus-x11 xdotool imagemagick x11-utils x11-xserver-utils
         fonts-dejavu fonts-noto-color-emoji tigervnc-standalone-server tigervnc-tools novnc websockify)
fi
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
else
  echo "all present"
fi

# --- uv (Python tool runner) ---------------------------------------------------
say "uv"
if ! have uv; then
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" | env UV_INSTALL_DIR="$BIN" sh
fi
uv --version

# --- Playwright MCP + Chromium (browser-agent) ---------------------------------
say "Playwright MCP $PLAYWRIGHT_MCP_VERSION + Chromium"
NPM_ROOT="$($SUDO npm root -g)"
if [ "$(node -p "require('$NPM_ROOT/@playwright/mcp/package.json').version" 2>/dev/null)" != "$PLAYWRIGHT_MCP_VERSION" ]; then
  $SUDO npm install -g "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION"
fi
PW_CLI="$NPM_ROOT/@playwright/mcp/node_modules/playwright/cli.js"
[ -f "$PW_CLI" ] || PW_CLI="$(find "$NPM_ROOT" -path '*node_modules/playwright/cli.js' | head -1)"
$SUDO node "$PW_CLI" install-deps chromium >/dev/null
node "$PW_CLI" install chromium

# --- rtk (shell output compression) -------------------------------------------
say "rtk $RTK_VERSION"
if [ "$(rtk --version 2>/dev/null | awk '{print $2}')" != "$RTK_VERSION" ]; then
  TMP="$(mktemp -d)"
  BASE="https://github.com/rtk-ai/rtk/releases/download/v$RTK_VERSION"
  curl -fsSL "$BASE/$RTK_ASSET" -o "$TMP/$RTK_ASSET"
  curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"
  (cd "$TMP" && grep " $RTK_ASSET\$" checksums.txt | sha256sum -c -)
  tar -xzf "$TMP/$RTK_ASSET" -C "$TMP"
  install -m 755 "$(find "$TMP" -name rtk -type f | head -1)" "$BIN/rtk"
  rm -rf "$TMP"
fi
rtk --version

# --- headroom (context compression proxy) -------------------------------------
say "headroom $HEADROOM_VERSION"
if [ "$(headroom --version 2>/dev/null | awk '{print $NF}')" != "$HEADROOM_VERSION" ]; then
  uv tool install --force --python 3.13 "headroom-ai[proxy,code,mcp]==$HEADROOM_VERSION"
fi

# --- Launchers and MCP wrappers -------------------------------------------------
say "Launchers in $BIN"
install -m 755 "$REPO/bin/hclaude" "$REPO/bin/browser-mcp" "$REPO/bin/chromium" "$BIN/"

# --- Virtual desktop + computer-use server -------------------------------------
if [ "$WITH_DESKTOP" = 1 ]; then
  say "Desktop (XFCE on TigerVNC :1, noVNC on :6080) + computer-use MCP"
  install -m 755 "$REPO/bin/desktop-start" "$REPO/bin/desktop-stop" "$REPO/bin/computer-mcp" "$BIN/"
  install -m 644 "$REPO/desktop/computer_mcp.py" "$SHARE/"
  if [ ! -x "$SHARE/venv/bin/python" ]; then uv venv -q "$SHARE/venv"; fi
  VIRTUAL_ENV="$SHARE/venv" uv pip install -q "mcp==$MCP_PY_VERSION"

  XFCONF="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
  mkdir -p "$XFCONF" "$HOME/.local/share/applications" "$HOME/.local/share/xfce4/helpers" \
           "$HOME/.config/xfce4/panel/launcher-11" "$HOME/.config/xfce4/panel/launcher-12" "$HOME/.config/xfce4/panel/launcher-13"
  cp "$REPO/desktop/xfce/xfce4-panel.xml" "$REPO/desktop/xfce/xfce4-power-manager.xml" "$XFCONF/"
  cp "$REPO/desktop/xfce/helpers.rc" "$HOME/.config/xfce4/"
  sed "s|__HOME__|$HOME|g" "$REPO/desktop/xfce/chromium.desktop" > "$HOME/.local/share/applications/chromium.desktop"
  sed "s|__HOME__|$HOME|g" "$REPO/desktop/xfce/custom-WebBrowser.desktop" > "$HOME/.local/share/xfce4/helpers/custom-WebBrowser.desktop"
  cp "$HOME/.local/share/applications/chromium.desktop" "$HOME/.config/xfce4/panel/launcher-11/"
  cp /usr/share/applications/xfce4-terminal.desktop "$HOME/.config/xfce4/panel/launcher-12/"
  cp /usr/share/applications/thunar.desktop "$HOME/.config/xfce4/panel/launcher-13/"

  "$BIN/desktop-start"
fi

# --- Claude Code: agents, CLAUDE.md, plugins, mods, rtk hook, settings ------------
if [ "$WITH_CLAUDE" = 1 ]; then
  "$REPO/install-claude-config.sh"
fi

say "Done"
cat <<EOF
Exit Claude Code (/exit) and reconnect to load the new setup (README, step 6).
Start Claude Code through headroom with:  hclaude
Watch the desktop: on your machine run 'sbx --cloud setup ssh' once, then
  ssh -N -L 6080:127.0.0.1:6080 <sandbox-id>@sbx_cloud
and open http://localhost:6080/vnc.html?autoconnect=1&resize=scale
EOF
