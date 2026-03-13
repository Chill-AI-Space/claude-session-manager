#!/bin/bash
# Quick update script for Claude Session Manager
# Usage: bash scripts/update.sh
set -e

cd "$(dirname "$0")/.."
echo "=== Claude Session Manager — Update ==="

# 1. Pull latest from GitHub
echo "[1/4] Pulling latest code..."
git pull --ff-only origin main

# 2. Install dependencies (only if package.json changed)
if git diff HEAD~1 --name-only 2>/dev/null | grep -q "package.json"; then
  echo "[2/4] Installing dependencies (package.json changed)..."
  npm install --prefer-offline
else
  echo "[2/4] Dependencies unchanged, skipping npm install"
fi

# 3. Rebuild
echo "[3/4] Building..."
rm -rf .next
npm run build 2>&1 | tail -5

# 4. Restart server
echo "[4/4] Restarting server..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: use launchd
  launchctl unload ~/Library/LaunchAgents/com.vova.claude-sessions.plist 2>/dev/null || true
  sleep 1
  launchctl load ~/Library/LaunchAgents/com.vova.claude-sessions.plist
  sleep 3
  echo "Server restarted via launchd"
else
  # Linux / WSL: kill old process, start new one
  pkill -f "next start" 2>/dev/null || true
  sleep 1
  nohup npm run start > /dev/null 2>&1 &
  sleep 3
  echo "Server started in background (PID: $!)"
fi

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/claude-sessions 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo ""
  echo "=== Update complete! Server is running on http://localhost:3000 ==="
else
  echo ""
  echo "=== WARNING: Server returned HTTP $HTTP_CODE. Check logs. ==="
fi
