#!/usr/bin/env node
// Live deploy for Claude Session Manager: the ONLY supported way to rebuild + restart a running instance.
//
// A plain "npm run build && launchctl unload/load" kills every Claude process the server spawned,
// and those sessions just stop mid-task. This script:
//   1. snapshots live sessions (before anything is touched)
//   2. (optional) pulls, installs deps if package.json changed, builds
//   3. restarts the service and waits for it to be healthy
//   4. resumes every snapshotted session that died in the restart, telling it "server was redeployed, continue"
//      (sessions that survived, e.g. interactive ones in a terminal, are left alone — no duplicates)
//   5. runs scripts/smoke-test.sh
//
// Usage: node scripts/deploy-live.js [--pull] [--restart-only] [--no-resume] [--dry-run]
//   --pull          git pull --ff-only origin main before building
//   --restart-only  skip pull/install/build (code is already built)
//   --no-resume     don't resume dead sessions (still snapshots them)
//   --dry-run       show live sessions and what would be resumed; change nothing
// Env: PORT (default 3000), DEPLOY_SYSTEMD_UNIT (Linux, default claude-session-manager)
//
// The real work runs in a detached worker, so deploying from inside a session that the restart kills
// does not kill the deploy itself; that session is in the snapshot and gets resumed afterwards.

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || "3000";
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.join(ROOT, "data", "deploy-snapshots");
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "com.vova.claude-sessions.plist");
const EXIT_MARK = "__DEPLOY_EXIT__";
const RESUME_MESSAGE =
  "Session Manager was redeployed and your process was interrupted by the restart — the session has been restored automatically. " +
  "Continue from where you left off; if the task was already finished, just say so briefly. " +
  "(Сервер был передеплоен, процесс прервался и был восстановлен — продолжай с того места, где остановился.)";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const log = (msg) => console.log(`[deploy ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(15000), ...init });
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return res.json();
}

async function healthy() {
  try {
    const res = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(4000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Sessions with a live process right now (+ orchestrator-tracked running ones). Server down → empty. */
async function liveSessions() {
  if (!(await healthy())) return [];
  const { sessions } = await api("/api/sessions?limit=500&include_remote=false");
  const live = new Map();
  for (const s of sessions) {
    if (s.is_active) live.set(s.session_id, { sessionId: s.session_id, agent: s.agent_type || "claude", path: s.project_path, title: s.custom_name || s.generated_title || s.first_prompt?.slice(0, 60) || "" });
  }
  try {
    const orch = await api("/api/orchestrator?include_remote=false");
    for (const st of orch.sessions || []) {
      if (["running", "retrying", "continuing"].includes(st.phase) && !live.has(st.sessionId)) {
        live.set(st.sessionId, { sessionId: st.sessionId, agent: "claude", path: st.projectPath, title: "" });
      }
    }
  } catch {}
  return [...live.values()];
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

function hasSystemdUnit(unit) {
  return spawnSync("systemctl", ["cat", unit], { stdio: "ignore" }).status === 0;
}

function restartService() {
  const unit = process.env.DEPLOY_SYSTEMD_UNIT || "claude-session-manager";
  if (process.platform === "darwin") {
    if (!fs.existsSync(PLIST)) throw new Error(`launchd plist not found: ${PLIST} (run scripts/install-mac.sh)`);
    spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
    spawnSync("sleep", ["1"]);
    run("launchctl", ["load", PLIST]);
  } else if (hasSystemdUnit(unit)) {
    // GCE / Linux VM: the unit must have KillMode=process so `claude` children aren't killed with the server
    // (see docs/gce-vm-setup-guide.md). Sessions that die anyway get resumed below.
    run("sudo", ["-n", "systemctl", "restart", unit]);
  } else {
    spawnSync("pkill", ["-f", "next start"], { stdio: "ignore" });
    spawnSync("sleep", ["1"]);
    spawn("npm", ["run", "start"], { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  }
}

async function deploy() {
  const dryRun = has("--dry-run");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Snapshot live sessions before touching anything
  const before = await liveSessions();
  const snapshotFile = path.join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(before, null, 2));
  log(`live sessions: ${before.length} (snapshot: ${path.relative(ROOT, snapshotFile)})`);
  for (const s of before) log(`  - ${s.sessionId.slice(0, 8)} [${s.agent}] ${s.path} ${s.title}`);

  if (dryRun) {
    const resumable = before.filter((s) => s.agent === "claude");
    log(`dry run: would resume up to ${resumable.length} claude session(s) that die in the restart; nothing changed`);
    return;
  }

  // 2. Pull / install / build (failure here aborts BEFORE the restart, so running sessions are untouched)
  if (!has("--restart-only")) {
    const oldHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    if (has("--pull")) run("git", ["pull", "--ff-only", "origin", "main"]);
    const changed = spawnSync("git", ["diff", "--name-only", oldHead, "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout;
    if (/package(-lock)?\.json/.test(changed)) run("npm", ["install", "--prefer-offline"]);
    run("npm", ["run", "build"], { env: { ...process.env, DEPLOY_LIVE: "1" } });
  }

  // 3. Restart + wait for health
  restartService();
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    await sleep(1000);
    up = await healthy();
  }
  if (!up) throw new Error(`server did not become healthy within 90s — check ~/Library/Logs/claude-session-manager-error.log`);
  log("server is healthy");

  // 4. Resume sessions that died in the restart
  await sleep(5000); // let process detection settle
  const after = new Set((await liveSessions()).map((s) => s.sessionId));
  const lost = before.filter((s) => !after.has(s.sessionId));
  log(`survived restart: ${before.length - lost.length}, died: ${lost.length}`);
  if (has("--no-resume")) {
    log("--no-resume: dead sessions NOT resumed: " + lost.map((s) => s.sessionId).join(", "));
  } else {
    for (const s of lost) {
      if (s.agent !== "claude") {
        log(`  ! ${s.sessionId.slice(0, 8)} is a ${s.agent} session — cannot auto-resume, resume it manually`);
        continue;
      }
      try {
        await api("/api/orchestrator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "resume", sessionId: s.sessionId, message: RESUME_MESSAGE, priority: "high" }),
        });
        log(`  ↻ resumed ${s.sessionId.slice(0, 8)} ${s.path}`);
      } catch (e) {
        log(`  ! resume FAILED for ${s.sessionId}: ${e.message}`);
        process.exitCode = 1;
      }
    }
  }

  // 5. Smoke test
  const smoke = spawnSync("bash", [path.join(ROOT, "scripts", "smoke-test.sh"), BASE], { cwd: ROOT, stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("smoke test failed — fix and redeploy");
  log("deploy complete");
}

async function main() {
  if (process.platform === "win32") {
    console.error("deploy-live.js is not supported on Windows (no process detection). Use scripts\\update.bat.");
    process.exit(2);
  }
  if (has("--worker") || has("--dry-run")) {
    let code = 0;
    try {
      await deploy();
      code = process.exitCode || 0;
    } catch (e) {
      log(`FAILED: ${e.message}`);
      code = 1;
    }
    if (has("--worker")) console.log(`${EXIT_MARK} ${code}`);
    process.exit(code);
  }

  // Foreground wrapper: run the worker detached (survives the restart killing our process group), stream its log.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFile = path.join(OUT_DIR, `deploy-${Date.now()}.log`);
  const fd = fs.openSync(logFile, "a");
  spawn(process.execPath, [__filename, "--worker", ...argv], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd] }).unref();
  console.log(`deploy running detached, log: ${logFile}`);
  let pos = 0;
  for (;;) {
    await sleep(500);
    const buf = fs.readFileSync(logFile, "utf8");
    const chunk = buf.slice(pos);
    pos = buf.length;
    const mark = chunk.indexOf(EXIT_MARK);
    if (mark >= 0) {
      process.stdout.write(chunk.slice(0, mark));
      process.exit(parseInt(chunk.slice(mark + EXIT_MARK.length), 10) || 0);
    }
    process.stdout.write(chunk);
  }
}

main();
