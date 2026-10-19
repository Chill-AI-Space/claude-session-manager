#!/usr/bin/env bash
# Example: continuous dev orchestration.
# Checks whether an opencode session is active for a project path.
# If none is active, starts a new one with a stored prompt.
# A session can create $DONE_FLAG to stop further spawns.
# Intended to be run every 3 minutes via cron:
#   */3 * * * * /path/to/orchestrate-dev.sh >> /tmp/orchestrate-dev.log 2>&1
set -euo pipefail

API="http://localhost:3000"
PROJECT_PATH="${PROJECT_PATH:-/Users/vova/code/chemistry-rnd/.worktrees/chemistry-gpt/session-https-chemistrygpt-ru-20261017-012055}"
PROMPT="${PROMPT:-Продолжи тестирование Chemistry GPT. План в operational memory (scope chemistry-gpt). Сначала получи Cloudflare creds через ZeroCreds и задеплой worker (таймауты повышены). Затем протестируй средние/сложные сценарии. Проверь waiting_input flow. Выключи будильник когда всё стабильно.}"
DONE_FLAG="${DONE_FLAG:-/tmp/chemistry-gpt-done}"

# If a "done" flag exists, do nothing.
if [ -f "$DONE_FLAG" ]; then
  echo "$(date): done flag found ($DONE_FLAG), skipping"
  exit 0
fi

PEERS=$(curl -s "$API/api/sessions/peers?path=$PROJECT_PATH&active_only=true")
COUNT=$(echo "$PEERS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers',[])))")

if [ "$COUNT" -eq "0" ]; then
  echo "$(date): no active session, starting new one"
  curl -s -N -X POST "$API/api/sessions/start" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"$PROJECT_PATH\",\"message\":\"$PROMPT\",\"agent\":\"opencode\"}" \
    | tail -3
else
  echo "$(date): active session exists ($COUNT), skip"
fi
