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
try {
  execSync(`find "${join(os.homedir(), '.cache', 'node-systray')}" -name 'tray_darwin_*' -exec chmod +x {} \\; 2>/dev/null`);
} catch {}

// --- Icon: white version for macOS menu bar (white on transparent, pre-built) ---
let icon = '';
try {
  icon = readFileSync(join(ROOT, 'src/app/icon-tray-white.png')).toString('base64');
} catch (e) {
  logErr(`Could not load icon: ${e.message}`);
}

// --- Start Next.js server ---
const server = spawn(
  process.execPath,
  ['node_modules/.bin/next', 'start'],
  {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));

server.on('exit', (code) => {
  logErr(`Server exited with code ${code}`);
  process.exit(code ?? 0);
});

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
      try { execSync(`open "${OPEN_URL}"`); } catch {}
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
  logErr(`Could not start tray (no GUI?), running as background server: ${e.message}`);
}

// --- Initial scan ---
log('Initial scan triggered, background scanner started');

function quit() {
  log('Shutting down...');
  try { if (tray) tray.kill(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  process.exit(0);
}

process.on('SIGTERM', quit);
process.on('SIGINT', quit);
