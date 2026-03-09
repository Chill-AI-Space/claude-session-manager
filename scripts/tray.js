#!/usr/bin/env node
// Menu bar tray app for Claude Session Manager.
// Starts the Next.js server and shows a macOS menu bar icon.
// If tray cannot start (e.g. no GUI context), server continues running anyway.

'use strict';

const { execSync, spawn } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const OPEN_URL = `http://localhost:${PORT}/claude-sessions`;

// --- Ensure systray binary is executable (npm install may leave it without +x) ---
try {
  execSync(`find "${join(os.homedir(), '.cache', 'node-systray')}" -name 'tray_darwin_*' -exec chmod +x {} \\; 2>/dev/null`);
} catch {}

// --- Icon: white version for macOS menu bar (white on transparent, pre-built) ---
let icon = '';
try {
  icon = readFileSync(join(ROOT, 'src/app/icon-tray-white.png')).toString('base64');
} catch (e) {
  console.error('[tray] Could not load icon:', e.message);
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
  console.log(`[tray] Server exited with code ${code}`);
  process.exit(code ?? 0);
});

// --- Tray (best-effort: if GUI is unavailable, skip silently) ---
let tray = null;
try {
  const Systray = require('systray2').default;

  tray = new Systray({
    menu: {
      icon,
      title: '',
      tooltip: 'Claude Session Manager',
      items: [
        { title: 'Open Session Manager', tooltip: 'Open in browser', checked: false, enabled: true },
        Systray.separator,
        { title: 'Quit', tooltip: 'Stop server and quit', checked: false, enabled: true },
      ],
    },
    debug: false,
    copyDir: true,
  });

  tray.onClick((action) => {
    if (action.seq_id === 0) {
      try { execSync(`open "${OPEN_URL}"`); } catch {}
    } else if (action.seq_id === 2) {
      quit();
    }
  });

  console.log('[tray] Menu bar icon active');
} catch (e) {
  console.error('[tray] Could not start tray (no GUI?), running as background server:', e.message);
}

function quit() {
  try { if (tray) tray.kill(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  process.exit(0);
}

process.on('SIGTERM', quit);
process.on('SIGINT', quit);
