#!/usr/bin/env node
// Menu bar tray app for Claude Session Manager.
// Starts the Next.js server and shows a macOS menu bar icon.
// If tray cannot start (e.g. no GUI context), server continues running anyway.

'use strict';

const { execSync, spawn } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');
const http = require('http');

const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const OPEN_URL = `http://localhost:${PORT}/claude-sessions`;

// --- Logging with timestamps ---
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [tray] ${msg}`);
}
function logErr(msg) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [tray] ${msg}`);
}

// --- Pre-flight checks ---
const buildIdPath = join(ROOT, '.next', 'BUILD_ID');
if (!existsSync(buildIdPath)) {
  logErr(`FATAL: No production build found (missing ${buildIdPath})`);
  logErr('Run "npm run build" in claude-session-manager before starting.');
  logErr('Auto-building now...');
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit', timeout: 120_000 });
    log('Auto-build succeeded');
  } catch (e) {
    logErr(`Auto-build FAILED: ${e.message}`);
    process.exit(10); // distinct exit code so launchd logs show build failure
  }
}

log(`Starting Next.js production server on port ${PORT}`);
log(`ROOT=${ROOT}, NODE=${process.execPath}, NODE_VERSION=${process.version}`);

// --- Ensure systray binary is executable (npm install may leave it without +x) ---
const isWin = process.platform === 'win32';
if (!isWin) {
  try {
    execSync(`find "${join(os.homedir(), '.cache', 'node-systray')}" -name 'tray_darwin_*' -exec chmod +x {} \\; 2>/dev/null`);
  } catch {}
}

// --- Icon: white version for macOS menu bar (white on transparent, pre-built) ---
let icon = '';
try {
  icon = readFileSync(join(ROOT, 'src/app/icon-tray-white.png')).toString('base64');
} catch (e) {
  logErr(`Could not load icon: ${e.message}`);
}

// --- Port management ---
function getPortPid() {
  if (isWin) return null;
  try {
    const out = execSync(`lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' }).trim();
    return out ? parseInt(out.split('\n')[0], 10) : null;
  } catch { return null; }
}

function freePort() {
  const pid = getPortPid();
  if (!pid) return;
  // Don't kill our own children
  try {
    const cmdLine = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim();
    if (cmdLine.includes('next') && cmdLine.includes('claude-session-manager')) {
      log(`Port ${PORT} held by our stale Next.js (PID ${pid}), killing`);
    } else {
      log(`Port ${PORT} held by foreign process (PID ${pid}): ${cmdLine.slice(0, 80)}`);
    }
    process.kill(pid, 'SIGTERM');
    // Give it a moment to die
    execSync('sleep 1');
    // Check if still alive
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    log(`Freed port ${PORT}`);
  } catch (e) {
    logErr(`Could not free port ${PORT}: ${e.message}`);
  }
}

// Free port before starting
freePort();

// --- Start Next.js server ---
const nextBin = isWin
  ? join(ROOT, 'node_modules', '.bin', 'next.cmd')
  : join(ROOT, 'node_modules', '.bin', 'next');

let server = null;

function spawnServer() {
  const proc = spawn(
    isWin ? nextBin : process.execPath,
    isWin ? ['start'] : [nextBin, 'start'],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWin,
    }
  );

  proc.stdout.on('data', (d) => process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));

  proc.on('exit', (code) => {
    logErr(`Server exited with code ${code}`);
    // Don't exit the tray — we'll restart the server on next "Open"
    server = null;
  });

  return proc;
}

server = spawnServer();

// --- Server health check & restart ---
function checkServerHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/settings`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureServerRunning() {
  const healthy = await checkServerHealth();
  if (healthy) return true;

  log('Server not responding, restarting...');

  // Kill old process if still hanging
  if (server) {
    try { server.kill('SIGKILL'); } catch {}
    server = null;
  }

  // Free port in case something else grabbed it
  freePort();

  // Spawn new server
  server = spawnServer();

  // Wait for it to become ready (up to 15s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await checkServerHealth();
    if (ok) {
      log('Server restarted successfully');
      return true;
    }
  }

  logErr('Server failed to start after 15s');
  return false;
}

// --- Settings helpers (read/write via localhost API) ---
const API_BASE = `http://localhost:${PORT}`;

function httpJson(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(path, API_BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getBabysitterState() {
  const settings = await httpJson('GET', '/api/settings');
  if (!settings) return { retry: true, stall: false }; // defaults
  return {
    retry: settings.auto_retry_on_crash !== 'false',
    stall: settings.auto_continue_on_stall === 'true',
  };
}

async function toggleBabysitter() {
  const state = await getBabysitterState();
  const anyOn = state.retry || state.stall;
  // Toggle: if any is on → turn both off; if both off → turn both on
  const newValue = !anyOn;
  await httpJson('PUT', '/api/settings', {
    auto_retry_on_crash: String(newValue),
    auto_continue_on_stall: String(newValue),
  });
  return newValue;
}

function babysitterLabel(on) {
  return `Babysitter: ${on ? 'ON' : 'OFF'}`;
}

// --- Tray (best-effort: if GUI is unavailable, skip silently) ---
let tray = null;
// seq_id mapping: 0=Open, 1=Babysitter, 2=separator, 3=Quit
const MENU_OPEN = 0;
const MENU_BABYSITTER = 1;
const MENU_QUIT = 3;

let trayAttempts = 0;
const MAX_TRAY_ATTEMPTS = 5;

function startTray() {
  trayAttempts++;
  try {
    const Systray = require('systray2').default;

    tray = new Systray({
      menu: {
        icon,
        title: '',
        tooltip: 'Claude Session Manager',
        items: [
          { title: 'Open Session Manager', tooltip: 'Open in browser', checked: false, enabled: true },
          { title: babysitterLabel(true), tooltip: 'Toggle auto-retry & auto-continue', checked: true, enabled: true },
          Systray.separator,
          { title: 'Quit', tooltip: 'Stop server and quit', checked: false, enabled: true },
        ],
      },
      debug: false,
      copyDir: true,
    });

    tray.onClick(async (action) => {
      if (action.seq_id === MENU_OPEN) {
        try {
          const ready = await ensureServerRunning();
          if (!ready) {
            logErr('Cannot open Session Manager — server failed to start');
            return;
          }
          const openCmd = isWin ? `start "" "${OPEN_URL}"` : `open "${OPEN_URL}"`;
          execSync(openCmd);
        } catch (e) {
          logErr(`Open failed: ${e.message}`);
        }
      } else if (action.seq_id === MENU_BABYSITTER) {
        try {
          const newState = await toggleBabysitter();
          tray.sendAction({
            type: 'update-item',
            item: { title: babysitterLabel(newState), tooltip: 'Toggle auto-retry & auto-continue', checked: newState, enabled: true },
            seq_id: MENU_BABYSITTER,
          });
          log(`Babysitter toggled → ${newState ? 'ON' : 'OFF'}`);
        } catch (e) {
          logErr(`Failed to toggle babysitter: ${e.message}`);
        }
      } else if (action.seq_id === MENU_QUIT) {
        quit();
      }
    });

    // Update babysitter label from actual settings once server is ready
    setTimeout(async () => {
      try {
        const state = await getBabysitterState();
        const on = state.retry || state.stall;
        tray.sendAction({
          type: 'update-item',
          item: { title: babysitterLabel(on), tooltip: 'Toggle auto-retry & auto-continue', checked: on, enabled: true },
          seq_id: MENU_BABYSITTER,
        });
      } catch {}
    }, 5000);

    log('Menu bar icon active');
  } catch (e) {
    tray = null;
    logErr(`Could not start tray (attempt ${trayAttempts}): ${e.message}`);
    if (trayAttempts < MAX_TRAY_ATTEMPTS) {
      const delayS = trayAttempts * 5;
      log(`Retrying tray in ${delayS}s (WindowServer may not be ready yet)...`);
      setTimeout(startTray, delayS * 1000);
    } else {
      logErr('Tray failed after all attempts — running as background server without menu bar icon');
    }
  }
}

// Watchdog: check every 30s if tray_darwin binary is still alive, restart if not
function startTrayWatchdog() {
  if (isWin) return;
  setInterval(() => {
    if (!tray) return; // tray never started or gave up
    try {
      const pgrep = execSync('pgrep -f tray_darwin 2>/dev/null', { encoding: 'utf8' }).trim();
      if (!pgrep) throw new Error('not running');
    } catch {
      log('Tray icon process died — restarting...');
      try { tray.kill(false); } catch {}
      tray = null;
      trayAttempts = 0;
      startTray();
    }
  }, 30_000);
}

// Delay first tray start slightly to let WindowServer initialize after login
setTimeout(() => {
  startTray();
  startTrayWatchdog();
}, isWin ? 0 : 3000);

// --- Initial scan ---
log('Server started, background scanner active');

function quit() {
  log('Shutting down...');
  try { if (tray) tray.kill(); } catch {}
  try { if (server) server.kill(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', quit);
process.on('SIGINT', quit);
if (isWin) {
  // Windows doesn't have SIGTERM; handle Ctrl+C via SIGINT (above) and console close:
  process.on('SIGHUP', quit);
}
