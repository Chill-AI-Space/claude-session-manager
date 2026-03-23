#!/bin/bash
# Install Claude Session Manager as a macOS menu bar app.
# Creates a launchd plist, loads it, and verifies the tray icon is running.
# Usage: scripts/install-mac.sh [--uninstall]

set -e

LABEL="com.claude-session-manager"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/claude-session-manager.log"
LOG_ERR="$LOG_DIR/claude-session-manager-error.log"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  $1"; }

# ── Uninstall ──
if [ "$1" = "--uninstall" ]; then
  echo "Uninstalling Claude Session Manager..."
  if launchctl list "$LABEL" &>/dev/null; then
    launchctl unload "$PLIST" 2>/dev/null
    ok "Service stopped"
  fi
  if [ -f "$PLIST" ]; then
    rm "$PLIST"
    ok "Removed $PLIST"
  else
    info "No plist found"
  fi
  echo ""
  echo "Done. Project files in $ROOT are untouched."
  echo "To fully remove: rm -rf $ROOT"
  exit 0
fi

echo ""
echo "Installing Claude Session Manager"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Check prerequisites ──
echo "1. Prerequisites"

# Node.js
NODE_BIN=$(which node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
  fail "Node.js not found. Install from https://nodejs.org (v18+ required)"
  exit 1
fi
NODE_VER=$(node -v 2>/dev/null)
ok "Node.js $NODE_VER ($NODE_BIN)"

# Node bin directory (for PATH in plist)
NODE_DIR=$(dirname "$NODE_BIN")

# npm dependencies
if [ ! -d "$ROOT/node_modules" ]; then
  warn "node_modules not found, running npm install..."
  (cd "$ROOT" && npm install)
  ok "npm install complete"
else
  ok "node_modules present"
fi

# Production build
if [ ! -f "$ROOT/.next/BUILD_ID" ]; then
  warn "No production build found, building..."
  (cd "$ROOT" && npm run build)
  ok "Build complete"
else
  ok "Production build present"
fi

# ── 2. Stop existing service if running ──
echo ""
echo "2. Service setup"

if launchctl list "$LABEL" &>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null
  sleep 1
  ok "Stopped existing service"
fi

# Kill anything on port 3000 that might conflict
EXISTING_PID=$(lsof -ti:3000 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  warn "Port 3000 in use (PID $EXISTING_PID), stopping..."
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

# ── 3. Create launchd plist ──
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>scripts/tray.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG_OUT</string>
    <key>StandardErrorPath</key>
    <string>$LOG_ERR</string>
</dict>
</plist>
PLIST_EOF

ok "Created $PLIST"

# ── 4. Load service ──
launchctl load "$PLIST"
ok "Service loaded (auto-starts on login)"

# ── 5. Wait for server to come up ──
echo ""
echo "3. Verifying"

SERVER_OK=false
for i in $(seq 1 15); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/claude-sessions 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    SERVER_OK=true
    break
  fi
  sleep 1
done

if $SERVER_OK; then
  ok "Server responding on http://localhost:3000"
else
  fail "Server not responding after 15s"
  echo "  Check logs: tail -50 $LOG_ERR"
  exit 1
fi

# Check tray icon
sleep 2
TRAY_PID=$(pgrep -f tray_darwin 2>/dev/null || true)
if [ -n "$TRAY_PID" ]; then
  ok "Menu bar icon active (look for white spiral ⟳)"
else
  warn "Menu bar icon may not be visible yet — it appears after a few seconds"
fi

# ── 4. Enable babysitter ──
echo ""
echo "4. Enabling babysitter"
curl -s -X PUT http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"auto_retry_on_crash":"true","auto_continue_on_stall":"true"}' >/dev/null 2>&1
ok "Babysitter ON (auto-retry crashed sessions + auto-continue stalled)"

# ── 5. Smoke test ──
echo ""
echo "5. Smoke test"
echo ""
"$ROOT/scripts/smoke-test.sh" http://localhost:3000
SMOKE_EXIT=$?

# ── 6. Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Installed!${NC}"
echo ""
echo "  Open:       http://localhost:3000/claude-sessions"
echo "  Menu bar:   white spiral icon → Open Session Manager / Babysitter / Quit"
echo "  Logs:       tail -f $LOG_OUT"
echo "  Errors:     tail -f $LOG_ERR"
echo "  Smoke test: $ROOT/scripts/smoke-test.sh"
echo "  Uninstall:  $ROOT/scripts/install-mac.sh --uninstall"
echo ""
echo "The server auto-starts on login. No Spotlight app needed — use the menu bar icon."
