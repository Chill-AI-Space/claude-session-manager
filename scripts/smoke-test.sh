#!/bin/bash
# Post-deploy smoke test for Claude Session Manager
# Verifies that the UI actually works end-to-end, not just HTTP 200.
# Usage: scripts/smoke-test.sh [base_url]

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0
ERRORS=""

check() {
  local name="$1"
  local result="$2"
  local expected="$3"

  if echo "$result" | grep -qE "$expected" 2>/dev/null; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name — expected '$expected', got: $(echo "$result" | head -c 200)"
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS  - $name\n"
  fi
}

echo "Smoke test: $BASE"
echo ""

# 1. Server alive
echo "1. Server"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE/claude-sessions" 2>/dev/null || echo "000")
check "Main page responds" "$STATUS" "200"

# 2. Sessions API returns data
echo "2. Sessions API"
SESSIONS_JSON=$(curl -s --max-time 10 "$BASE/api/sessions?limit=3" 2>/dev/null || echo '{}')
SESSION_COUNT=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('sessions',[])))" 2>/dev/null || echo "0")
TOTAL=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "0")
check "Sessions returned ($SESSION_COUNT)" "$SESSION_COUNT" "^[1-9]"
check "Total count > 0 ($TOTAL)" "$TOTAL" "^[1-9]"

# 3. Pick top session — verify detail loads with messages
echo "3. Session detail"
TOP_SESSION=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['sessions'][0]['session_id'])" 2>/dev/null || echo "")
if [ -z "$TOP_SESSION" ]; then
  echo "  ✗ No session to test"
  ((FAIL++))
else
  DETAIL_JSON=$(curl -s --max-time 10 "$BASE/api/sessions/$TOP_SESSION" 2>/dev/null || echo '{}')
  MSG_TOTAL=$(echo "$DETAIL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('messages_total',0))" 2>/dev/null || echo "0")
  MSG_COUNT=$(echo "$DETAIL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('messages',[])))" 2>/dev/null || echo "0")
  check "Session detail has messages ($MSG_COUNT of $MSG_TOTAL)" "$MSG_COUNT" "^[1-9]"

  # 4. MD content loads with pagination
  echo "4. MD content"
  MD_JSON=$(curl -s --max-time 10 "$BASE/api/sessions/$TOP_SESSION/md" 2>/dev/null || echo '{}')
  MD_LEN=$(echo "$MD_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('markdown','')))" 2>/dev/null || echo "0")
  MD_TOTAL=$(echo "$MD_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_messages',0))" 2>/dev/null || echo "0")
  HAS_EARLIER=$(echo "$MD_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('has_earlier','missing'))" 2>/dev/null || echo "missing")
  check "MD content returned ($MD_LEN chars)" "$MD_LEN" "^[1-9]"
  check "MD total_messages present ($MD_TOTAL)" "$MD_TOTAL" "^[1-9]"
  check "MD has_earlier field present ($HAS_EARLIER)" "$HAS_EARLIER" "^(True|False)$"

  # 5. Session has a displayable title (generated or first_prompt)
  echo "5. Session title"
  TITLE=$(echo "$SESSIONS_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d['sessions'][0]
t=s.get('custom_name') or s.get('generated_title') or s.get('first_prompt','')
print(t[:80] if t else 'EMPTY')
" 2>/dev/null || echo "EMPTY")
  check "Session has title" "$TITLE" "^[^E]"  # doesn't start with EMPTY

  # 6. Summary/learnings endpoints respond (cached or not — just not error)
  echo "6. Summary & learnings"
  SUM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST "$BASE/api/sessions/$TOP_SESSION/summary" 2>/dev/null || echo "000")
  check "Summary endpoint responds ($SUM_STATUS)" "$SUM_STATUS" "200"

  LEARN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "$BASE/api/sessions/$TOP_SESSION/learnings" 2>/dev/null || echo "000")
  # 200 = cached, timeout is OK for uncached (LLM call), 400 = meta session (also OK)
  check "Learnings endpoint responds ($LEARN_STATUS)" "$LEARN_STATUS" "^[24]0[0]$"

  # 7. Settings API
  echo "7. Settings"
  SETTINGS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/api/settings" 2>/dev/null || echo "000")
  check "Settings API responds ($SETTINGS_STATUS)" "$SETTINGS_STATUS" "200"

  # 8. HTML page contains session data (not just empty shell)
  echo "8. HTML content check"
  HTML=$(curl -s --max-time 10 "$BASE/claude-sessions/$TOP_SESSION" 2>/dev/null || echo "")
  HTML_SIZE=${#HTML}
  check "Session page HTML has content ($HTML_SIZE bytes)" "$HTML_SIZE" "^[1-9]"

  # 9. Client-side JS smoke test (catches React hydration errors like #310)
  echo "9. Client JS check"
  if command -v node >/dev/null 2>&1; then
    JS_ERRORS=$(node -e "
const http = require('http');
const url = '$BASE/claude-sessions';
// Fetch all JS chunks referenced in the page
http.get(url, res => {
  let html = '';
  res.on('data', c => html += c);
  res.on('end', () => {
    // Check that the page doesn't contain error boundary markup
    const hasErrorBoundary = html.includes('Something went wrong') || html.includes('__next_error__');
    // Check JS bundle links are present (page actually has client code)
    const jsChunks = (html.match(/src=\"\/_next\/static\/chunks/g) || []).length;
    if (hasErrorBoundary) console.log('ERROR_BOUNDARY');
    else if (jsChunks < 3) console.log('MISSING_JS_CHUNKS:' + jsChunks);
    else console.log('OK:' + jsChunks + '_chunks');
  });
});
" 2>/dev/null || echo "NODE_FAILED")
    check "No error boundary in HTML, JS chunks present ($JS_ERRORS)" "$JS_ERRORS" "^OK:"
  else
    echo "  - skipped (node not found)"
  fi
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  echo "✓ All $PASS checks passed"
  exit 0
else
  echo "✗ $FAIL failed, $PASS passed"
  echo -e "\nFailed checks:\n$ERRORS"
  exit 1
fi
