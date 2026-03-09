#!/bin/bash
# permission-bridge.sh — Bridge Claude CLI permission prompts to Session Manager web UI
#
# This is a PermissionRequest hook for Claude Code.
# When Claude needs permission for a tool, this script:
# 1. Sends the request to Session Manager API
# 2. Waits for the user to Allow/Deny from the web UI
# 3. Returns the decision to Claude
#
# If Session Manager is unreachable, falls through silently (exit 0 = show normal terminal prompt)

SM_URL="${CLAUDE_SM_URL:-http://localhost:3000}"
POLL_INTERVAL=1
MAX_WAIT=120

# Read permission request from stdin
REQUEST=$(cat)

# Try to POST to Session Manager
RESPONSE=$(echo "$REQUEST" | curl -s -m 5 -X POST "$SM_URL/api/permissions/request" \
  -H 'Content-Type: application/json' -d @- 2>/dev/null) || exit 0

ID=$(echo "$RESPONSE" | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -z "$ID" ] && exit 0

# Poll for decision
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  DECISION=$(curl -s -m 5 "$SM_URL/api/permissions/$ID/poll" 2>/dev/null) || exit 0
  STATUS=$(/usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('status','pending'))" <<< "$DECISION" 2>/dev/null)

  if [ "$STATUS" = "decided" ]; then
    /usr/bin/python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('response',{})))" <<< "$DECISION"
    exit 0
  fi

  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Timeout — fall through to normal terminal prompt
exit 0
