# Claude Session Manager

Next.js app (App Router) + better-sqlite3. Web UI for browsing and managing Claude Code sessions.

**Cross-platform:** works on macOS, Windows, and Linux.

## Stack

- Next.js 16 (Turbopack in dev), React 19, Tailwind CSS 4, shadcn/ui
- Database: `data/sessions.db` (SQLite via better-sqlite3)
- Settings: `~/.config/claude-session-manager/settings.json` (JSON file, NOT in DB)

## Commands

```bash
npm run dev          # dev server with Turbopack (http://localhost:3000)
npm run build        # production build
npm run start        # production server (http://localhost:3000)
```

## Windows setup (one-click)

Prerequisites: **Node.js 18+** (https://nodejs.org). Git optional (can download zip).

```
git clone <repo-url>
cd claude-session-manager
scripts\setup-windows.bat
```

The script will: check Node.js → `npm install` → `npm run build` → start server → open browser.

To update later: `scripts\update.bat`

### Windows limitations

- **Process detection** — `ps`/`lsof` not available; active session detection is disabled (`process-detector.ts` returns `[]` on Windows). Sessions still show but without live "active" status.
- **Kill session** — SIGTERM-based terminal kill is not supported. The UI shows a warning on the Help page.
- **Tray icon** — systray2 works on Windows but the icon is optimized for macOS dark menu bar (white on transparent). It will appear but may look odd on Windows taskbar.
- **Permission bridge hook** — uses `permission-bridge.cmd` on Windows (not `.sh`). The `.cmd` script must exist in `scripts/` for the install feature to work.
- **Claude CLI path** — resolved via `where claude` on Windows. If Claude is installed via npm global, WinGet, or to a custom path, it should be in PATH.

## Deploy workflow

Always test on dev first, then deploy to production.
**MANDATORY: After every deploy, run the health checks (step 3). If any check fails — fix and redeploy. Do NOT consider the deploy done until all checks pass.**

### 1. Start dev server and verify

```bash
cd ~/Documents/GitHub/claude-session-manager
lsof -ti:3000 | xargs kill -9 2>/dev/null
rm -rf .next
npm run dev
```

Verify your changes work:
- Open http://localhost:3000 and check the UI
- For settings changes: `curl http://localhost:3000/api/settings | jq .your_key`
- For new UI sections: navigate to the page and confirm it renders

### 2. Build and restart production (via launchd)

Production runs as a **launchd service** (NOT nohup). The entrypoint is `scripts/tray.js` which:
- Shows a **macOS menu bar icon** (Quasar symbol, grayscale, via `systray2`)
- Spawns `next start` as a child process
- Menu: "Open Session Manager" (opens browser) | "Quit" (stops server + tray)

Logs go to `~/Library/Logs/`, not `/tmp/`.

Stop dev (Ctrl+C), then:

```bash
cd ~/Documents/GitHub/claude-session-manager
npm run build 2>&1 | tail -5
# ↑ MUST see "prerendered as static content" / route list at the end
# If build fails — fix the error, do NOT proceed

# Restart the launchd service (it will auto-start on reboot too)
launchctl unload ~/Library/LaunchAgents/com.vova.claude-sessions.plist
sleep 1
launchctl load ~/Library/LaunchAgents/com.vova.claude-sessions.plist
sleep 3
```

### 3. Post-deploy health checks (MANDATORY)

Run ALL of these after every deploy. If any returns non-200 or error — the deploy is broken.

```bash
# 1. Server process is alive
lsof -i:3000 | grep LISTEN

# 2. Main page responds 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/claude-sessions

# 3. API responds with JSON
curl -s http://localhost:3000/api/sessions | head -c 200

# 4. Settings API responds
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/settings

# 5. No errors in server log (launchd logs, NOT /tmp)
tail -20 ~/Library/Logs/claude-session-manager.log
tail -20 ~/Library/Logs/claude-session-manager-error.log

# 6. Reply (spawn claude) works — critical check
curl -s -X POST http://localhost:3000/api/sessions/$(curl -s http://localhost:3000/api/sessions | python3 -c "import json,sys; s=json.load(sys.stdin); print(s[0]['session_id'])" 2>/dev/null)/reply \
  -H "Content-Type: application/json" -d '{"message":"ping"}' --max-time 30 | head -c 200

# 7. Debug log pipeline ping (non-blocking — skip if debug_log_endpoint not set)
curl -s -X POST http://localhost:3000/api/debug/ping | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Debug ping: {d[\"status\"]} ({d.get(\"totalMs\",\"?\")}{\"ms\" if \"totalMs\" in d else \"\"})')"
```

**If any check fails:**
1. Check `tail -50 ~/Library/Logs/claude-session-manager-error.log` for the error
2. If process died — `rm -rf .next`, rebuild, reload launchd
3. If port busy — `lsof -ti:3000 | xargs kill -9`, then `launchctl load ...`
4. Fix the root cause and redeploy from step 2

### Common issues (macOS)

- **Turbopack cache corruption** — `rm -rf .next` and rebuild
- **Port 3000 busy** — `lsof -ti:3000 | xargs kill -9`
- **Process dies silently after "Ready"** — check `tail -50 ~/Library/Logs/claude-session-manager-error.log`, likely a runtime import error
- **"signal is aborted without reason"** — always pass a reason to `abort()`, e.g. `abort("cancelled")`
- **Build fails on `/_global-error`** — clear `.next` cache and rebuild
- **`spawn claude ENOENT`** — launchd PATH doesn't include `/Users/vova/.local/bin`. Fix: edit `~/Library/LaunchAgents/com.vova.claude-sessions.plist`, add `/Users/vova/.local/bin` to PATH, reload launchd.
- **Tray icon not appearing** — run `node scripts/tray.js` manually to debug. If `tray_darwin_release` gets EACCES: `find ~/.cache/node-systray -name 'tray_darwin_*' -exec chmod +x {} \;`
- **launchd keeps restarting/dying** — check `launchctl list com.vova.claude-sessions` for LastExitStatus; check both log files.

### Common issues (Windows)

- **`npm install` fails on better-sqlite3** — needs C++ build tools. Fix: `npm install --global windows-build-tools` or install "Desktop development with C++" from Visual Studio Build Tools (https://visualstudio.microsoft.com/visual-cpp-build-tools/). Node 18+ with recent npm usually has prebuilt binaries and skips compilation.
- **Port 3000 busy** — `netstat -aon | findstr ":3000" | findstr "LISTENING"` to find PID, then `taskkill /f /pid <PID>`
- **`spawn claude ENOENT`** — Claude CLI not in PATH. Run `where claude` to check. Install: `npm install -g @anthropic-ai/claude-code`
- **CMD window flashes** — all spawns use `windowsHide: true`, but if a CMD still flashes, check that the spawn has this option set
- **Turbopack cache corruption** — `rmdir /s /q .next` and rebuild

### Dev debugging

Run `npm run dev` in foreground to see server errors. Client-side React errors only appear in the browser console / Next.js error overlay.

## Settings system

Settings are stored in `~/.config/claude-session-manager/settings.json` as a flat `{ key: value }` JSON object.

### API

- `GET /api/settings` — returns all settings (defaults merged with saved)
- `PUT /api/settings` — body `{ "key": "value" }`, saves and returns all settings

### Adding a setting from another project

To register a new setting that appears in the Session Manager UI:

1. Add default value in `src/lib/db.ts` → `SETTING_DEFAULTS`
2. Add UI controls in `src/app/claude-sessions/settings/page.tsx`
3. Add search keyword in the `searchIndex` map (same file) so the setting is discoverable via search
4. Deploy (see above)

To just read/write a setting programmatically without UI changes:

```bash
# Read all settings
curl http://localhost:3000/api/settings

# Write a setting
curl -X PUT http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"my_setting_key": "value"}'
```

Settings are immediately available — no restart needed. The UI reads them on page load.

## Cross-platform development rules

When writing new code, follow these rules to keep Windows compatibility:

- **Home directory**: use `os.homedir()`, never `process.env.HOME` (undefined on Windows)
- **Paths**: use `path.join()`, never hardcode `/`. When splitting paths: `p.split(/[\\/]/)` to handle both separators
- **Binary lookup**: `which` → `where` on Windows. Use `getClaudePath()` from `src/lib/claude-bin.ts`
- **File permissions**: `chmodSync` is a no-op on Windows. Guard with `if (process.platform !== "win32")`
- **Shell commands**: `ps`, `lsof`, `kill`, `grep`, `open` don't exist on Windows. Guard with `process.platform` check or provide Windows alternatives (`tasklist`, `netstat`, `taskkill`, `findstr`, `start`)
- **spawn()**: always pass `windowsHide: true` to prevent CMD popups. Use `shell: true` when spawning `.cmd` files. `detached: true` creates a new process group on Windows (different from Unix) — usually skip it on Windows
- **Signals**: `SIGTERM`/`SIGKILL` work differently. Use `proc.kill()` without arguments for cross-platform compatibility
- **Line endings**: JSONL parsing should handle `\r\n` (use `split(/\r?\n/)`)
- **Path in Claude projects dir**: `pathToProjectDir()` replaces both `/` and `\` with `-`
