#!/bin/bash
# Post-deploy smoke test for Claude Session Manager
# Verifies that the UI actually works end-to-end, not just HTTP 200.
# Works on both fresh installs (empty DB) and populated instances.
# Usage: scripts/smoke-test.sh [base_url]

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0
SKIP=0
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

skip() {
  local name="$1"
  local reason="$2"
  echo "  ○ $name — skipped ($reason)"
  SKIP=$((SKIP + 1))
}

echo "Smoke test: $BASE"
echo ""

# 1. Server alive
echo "1. Server"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE/claude-sessions" 2>/dev/null)
STATUS="${STATUS:-000}"
check "Main page responds" "$STATUS" "200"

# 2. Sessions API returns valid response (may be empty on fresh install)
echo "2. Sessions API"
SESSIONS_JSON=$(curl -s --max-time 10 "$BASE/api/sessions?limit=3&include_remote=false" 2>/dev/null || echo '{}')
SESSION_COUNT=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('sessions',[])))" 2>/dev/null || echo "ERR")
TOTAL=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "ERR")
# API must return valid JSON with sessions array — count can be 0
check "Sessions API responds ($SESSION_COUNT sessions, $TOTAL total)" "$SESSION_COUNT" "^[0-9]"

# 3. Pick top session — verify detail loads with messages (skip if empty)
echo "3. Session detail"
TOP_SESSION=$(echo "$SESSIONS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); ss=d.get('sessions',[]); print(ss[0]['session_id'] if ss else '')" 2>/dev/null || echo "")
if [ -z "$TOP_SESSION" ]; then
  skip "Session detail" "no sessions yet (clean install)"
  skip "MD content" "no sessions"
  skip "MD total_messages" "no sessions"
  skip "MD has_earlier" "no sessions"
  skip "Session title" "no sessions"
  skip "Summary endpoint" "no sessions"
  skip "Learnings endpoint" "no sessions"
  skip "Session page HTML" "no sessions"
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
  SUM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST "$BASE/api/sessions/$TOP_SESSION/summary" 2>/dev/null)
  SUM_STATUS="${SUM_STATUS:-000}"
  # 200 = generated, 400 = not supported (codex/forge sessions) — both OK
  check "Summary endpoint responds ($SUM_STATUS)" "$SUM_STATUS" "^[24]0[0]$"

  LEARN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST "$BASE/api/sessions/$TOP_SESSION/learnings" 2>/dev/null)
  LEARN_STATUS="${LEARN_STATUS:-000}"
  # 200 = cached or freshly generated, 400 = meta session (also OK)
  check "Learnings endpoint responds ($LEARN_STATUS)" "$LEARN_STATUS" "^[24]0[0]$"

  # 7. HTML page contains session data (not just empty shell)
  echo "7. Session page HTML"
  HTML=$(curl -s --max-time 10 "$BASE/claude-sessions/$TOP_SESSION" 2>/dev/null || echo "")
  HTML_SIZE=${#HTML}
  check "Session page HTML has content ($HTML_SIZE bytes)" "$HTML_SIZE" "^[1-9]"
fi

# 8. Settings API (always works, even on fresh install)
echo "8. Settings"
SETTINGS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/api/settings" 2>/dev/null)
SETTINGS_STATUS="${SETTINGS_STATUS:-000}"
check "Settings API responds ($SETTINGS_STATUS)" "$SETTINGS_STATUS" "200"

# 9. Health API
echo "9. Health"
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/api/health" 2>/dev/null)
HEALTH_STATUS="${HEALTH_STATUS:-000}"
check "Health API responds ($HEALTH_STATUS)" "$HEALTH_STATUS" "200"

# 10. Client-side JS smoke test (catches React hydration errors)
echo "10. Client JS check"
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
  skip "Client JS check" "node not found"
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  if [ "$SKIP" -gt 0 ]; then
    echo "✓ All $PASS checks passed, $SKIP skipped (clean install)"
  else
    echo "✓ All $PASS checks passed"
  fi
  exit 0
else
  echo "✗ $FAIL failed, $PASS passed, $SKIP skipped"
  echo -e "\nFailed checks:\n$ERRORS"
  exit 1
fi
