# Delegation Guide

How to spawn sub-sessions, get results back, and coordinate multi-step work.

---

## Rule #0 — Persist everything before finishing

**If a session dies without saving its work, that work is gone.** The session chain breaks, and the next session has nothing to build on.

### Code → commit to a branch

```bash
git add -p && git commit -m "wip: description"
git push origin HEAD  # make it reachable across machines
```

Not in git → doesn't exist from another session's perspective. Uncommitted changes are invisible across session boundaries. Commit even partial work — a WIP commit is recoverable, lost context is not.

### Plans, reports, findings → save to a file with date

```bash
# Name format: YYYY-MM-DD-description.md
# Easy to find, easy to delete when done
echo "..." > docs/2026-04-13-migration-plan.md
git add docs/2026-04-13-migration-plan.md && git commit -m "wip: migration plan draft"
```

Dates in filenames = easy cleanup later (`find docs -name "2026-*" | sort`).

### Before calling DONE or FAILED — checkpoint checklist

Before a worker reports back, it must:
1. **Code written** → committed to a branch (even partial — `wip:` prefix ok)
2. **Plan / findings / report** → saved to a dated file and committed
3. **Nothing left only in session context** — if it's not in git, it doesn't exist

Completing work without persisting = losing the work. Don't do it.

---

## Simple delegation — "do this and report back"

Spawn a session, give it a task, wait for DONE/FAILED.

```bash
curl -s -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/project",
    "message": "Fix the auth bug in login.ts. Commit the fix. Report DONE or FAILED.",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "fix auth bug",
    "agent": "claude"
  }'
```

The child session gets a `[Delegation Contract]` injected automatically — it knows to call `/reply` with DONE/FAILED when done.

**Your session ID** is in the `[Session Manager Context]` block at the top of your system prompt.
Verify: `curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)"`

**Finish your turn** after spawning. Session Manager wakes you when the child replies.

**If the child crashes** without replying → babysitter pings it 3×, then auto-sends FAILED to you.

**Agent types:** `"claude"` (default), `"codex"`, `"forge"`.

---

## What to include in the message

The child has no memory of your conversation. Include everything it needs:

- What's already done / branch / commit hash
- The exact task for this session
- Constraints (don't deploy, don't touch prod, read-only, etc.)
- Where to find relevant files

---

## Signaling an already-running session

```bash
# Fire-and-forget (returns immediately, doesn't block)
curl -s -X POST "http://localhost:3000/api/orchestrator" \
  -H "Content-Type: application/json" \
  -d '{"type":"resume","sessionId":"TARGET_ID","message":"deploy done, run tests","priority":"high"}'
```

Use orchestrator (not `/reply`) for inter-session signals — `/reply` blocks until the target finishes responding.

---

## Coordinator pattern — multi-step plan with iterations

For plans with many iterations where one session needs to orchestrate the whole sequence.

**Read:** `/Users/vova/Documents/GitHub/claude-session-manager/docs/coordinator-prompt-template.md`

Short version:
- Coordinator = long-lived Claude session with alarm, holds the plan
- Workers = stateless sessions (Claude or Codex), do one iteration, report DONE/FAILED, die
- Coordinator wakes on each report, launches next worker, goes back to sleep

```
Coordinator (alarm set) → spawns Worker → Worker reports DONE/FAILED → Coordinator wakes → next Worker → ...
```

**Codex as worker, Claude as reviewer** — per-iteration pattern:
1. Spawn Codex worker: implement the task
2. Wait for DONE
3. Spawn Claude reviewer: review Codex output, report `DONE: verdict OK` or `DONE: verdict NEEDS_FIX`
4. Coordinator decides: next iteration or fix pass

---

## CI/CD callback — get notified when GitHub Actions finishes

When you create a PR, embed your session ID so CI can wake you up with results.

### Step 1 — add callback to PR description

```bash
MY_SESSION_ID=$(curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)" | jq -r '.session_id')
RELAY_URL=$(curl -s http://localhost:3000/api/settings | jq -r '.csm_base_url')

gh pr create \
  --title "..." \
  --body "$(cat <<EOF
<your PR description here>

<!-- session: $MY_SESSION_ID -->
[Report CI results →]($RELAY_URL/api/sessions/$MY_SESSION_ID/reply)
EOF
)"
```

### Step 2 — add this as the last step in your GitHub Actions job

```yaml
- name: Notify Claude session
  if: always()
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    SESSION=$(gh pr view ${{ github.event.pull_request.number }} \
      --json body -q '.body' | \
      grep -o 'session: [a-z0-9-]*' | awk '{print $2}')
    [ -z "$SESSION" ] && exit 0
    curl -s -X POST "$RELAY_URL/api/sessions/$SESSION/reply" \
      -H "Content-Type: application/json" \
      -d '{"message":"CI ${{ job.status }}: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
```

Replace `$RELAY_URL` with your relay URL (or use a secret `CSM_RELAY_URL`).

### Step 3 — set your alarm, then finish your turn

```bash
curl -s -X POST "http://localhost:3000/api/sessions/$MY_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message":"CI results arrived. Check status: success → merge; failure → read run URL and fix.", "check_after_ms": 600000}'
```

Then end your turn. When CI finishes it replies directly to your session — babysitter wakes you with the result (success/failure + run URL).

**Preferred: use the WebSocket relay for a stable URL that never changes.**
Enable Remote Relay in Settings → the CI button in session detail will auto-generate the correct relay endpoint (`https://csm-relay.chillai.workers.dev/node/{NODE_ID}/resume`).
If relay is off, falls back to `csm_base_url` (cloudflared — ephemeral, breaks on restart).

The **CI button** in any session's detail page generates ready-to-copy snippets with the correct URL for your current setup.

---

## Self-alarm — don't lose your thread if you crash

Sessions are not reliable. Processes die, connections drop, machines sleep. The self-alarm is the fix: before any risky operation, tell the babysitter what to do if you don't come back.

```bash
# 1. Arm — set before the risky thing
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Resume: step 3 of deploy — run smoke tests, then launchctl reload",
    "check_after_ms": 180000
  }'

# 2. Do the thing

# 3. Disarm on success
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm"
```

While alarm is active, **babysitter backs off** — no crash retry, no stall poke. The alarm owns recovery.

If the babysitter resumes you and you don't need it anymore:
```bash
# Disable babysitter for this session permanently (until you clear it)
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm"

# Re-enable babysitter
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm?clear=true"
```

Every babysitter message already contains your disable curl — just copy and run it.

---

## Codex specifics

Codex is a TUI — it doesn't receive `[Session Manager Context]` automatically via `--append-system-prompt`. But it's still fully tracked by Session Manager (via `~/.codex/state_5.sqlite` scan) and can use all the same APIs.

**Give Codex its session ID and instructions in the initial task message:**

```
Your task: <task description>

Session Manager context:
- Find your session ID: curl -s "http://localhost:3000/api/sessions/peers?path=$(pwd)" | jq -r '.peers[0].session_id'
- Self-alarm (set before risky ops): POST http://localhost:3000/api/sessions/YOUR_ID/alarm
    body: {"message": "what to do if I die", "check_after_ms": 180000}
- Disable babysitter: curl -s -X DELETE http://localhost:3000/api/sessions/YOUR_ID/alarm
- Report back to parent: POST http://localhost:3000/api/sessions/PARENT_ID/reply
    body: {"message": "DONE: <summary>"} or {"message": "FAILED: <reason>"}

Read full guide: /Users/vova/Documents/GitHub/claude-session-manager/docs/delegation-guide.md
```

When Codex needs to spawn a sub-session, use `agent: "claude"` — Claude sessions get full context injection automatically.
