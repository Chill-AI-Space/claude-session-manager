#!/usr/bin/env node
// @ts-check
/**
 * Log Analyzer — reads actions_log + server logs, detects anomalies,
 * creates GitHub Issues when something interesting is found.
 *
 * Runs via LaunchAgent every 2 hours (com.vova.claude-sessions-analyzer.plist)
 * Can also be run manually: node scripts/log-analyzer.js [--dry-run] [--hours=4]
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// ── Config ──────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "..", "data", "sessions.db");
const LOG_PATH = path.resolve(process.env.HOME, "Library/Logs/claude-session-manager.log");
const ERROR_LOG_PATH = path.resolve(process.env.HOME, "Library/Logs/claude-session-manager-error.log");
const REPO = "kobzevvv/claude-session-manager";
const STATE_PATH = path.join(__dirname, "..", "data", "analyzer-state.json");

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const hoursArg = args.find((a) => a.startsWith("--hours="));
const HOURS = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 2;

const now = new Date();
const since = new Date(now.getTime() - HOURS * 60 * 60 * 1000);
const sinceStr = since.toISOString().replace("T", " ").slice(0, 19);

function log(msg) {
  console.log(`[${new Date().toISOString()}] [analyzer] ${msg}`);
}

// ── State (remember what was already reported) ──────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { reported_issues: [], last_run: null };
  }
}

function saveState(state) {
  state.last_run = now.toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function issueKey(type, detail) {
  // Deduplicate by type + detail within 24h
  const day = now.toISOString().slice(0, 10);
  return `${day}:${type}:${detail}`;
}

// ── Detectors ───────────────────────────────────────────────────────────────────

function detectRepeatCrashers(db) {
  // Sessions that crashed 3+ times in the window
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) as crash_count,
              MIN(created_at) as first_crash, MAX(created_at) as last_crash
       FROM actions_log
       WHERE action = 'crash_detected' AND created_at >= ?
       GROUP BY session_id
       HAVING crash_count >= 3
       ORDER BY crash_count DESC`
    )
    .all(sinceStr);

  return rows.map((r) => ({
    type: "repeat-crash",
    title: `Session crashing repeatedly: ${r.session_id.slice(0, 8)} (${r.crash_count}x in ${HOURS}h)`,
    body: [
      `**Session:** \`${r.session_id}\``,
      `**Crash count:** ${r.crash_count} in last ${HOURS}h`,
      `**First crash:** ${r.first_crash}`,
      `**Last crash:** ${r.last_crash}`,
      "",
      "This session is crash-looping. Check if auto-retry is making it worse.",
    ].join("\n"),
    dedup: r.session_id,
  }));
}

function detectFailedRetries(db) {
  // auto_retry_failed — retry was attempted but didn't help
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) as fail_count, MAX(created_at) as last_fail, MAX(details) as details
       FROM actions_log
       WHERE action IN ('auto_retry_failed', 'stall_continue_failed') AND created_at >= ?
       GROUP BY session_id
       ORDER BY fail_count DESC`
    )
    .all(sinceStr);

  return rows
    .filter((r) => r.fail_count >= 2)
    .map((r) => ({
      type: "retry-failed",
      title: `Auto-retry failing for ${r.session_id.slice(0, 8)} (${r.fail_count}x)`,
      body: [
        `**Session:** \`${r.session_id}\``,
        `**Failed retries:** ${r.fail_count}`,
        `**Last failure:** ${r.last_fail}`,
        `**Details:** ${r.details || "none"}`,
        "",
        "Auto-retry/continue keeps failing. May need manual intervention or the session has a persistent issue.",
      ].join("\n"),
      dedup: r.session_id,
    }));
}

function detectHighCrashRate(db) {
  // Overall crash rate anomaly: more than 10 crashes in the window
  const row = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN action = 'crash_detected' THEN 1 ELSE 0 END) as crashes,
              COUNT(DISTINCT CASE WHEN action = 'crash_detected' THEN session_id END) as sessions_affected
       FROM actions_log WHERE created_at >= ?`
    )
    .get(sinceStr);

  if (row.crashes >= 30) {
    return [
      {
        type: "high-crash-rate",
        title: `High crash rate: ${row.crashes} crashes across ${row.sessions_affected} sessions in ${HOURS}h`,
        body: [
          `**Total crashes:** ${row.crashes}`,
          `**Sessions affected:** ${row.sessions_affected}`,
          `**Total actions in window:** ${row.total}`,
          "",
          "Crash rate is abnormally high. Possible systemic issue (API outage, resource exhaustion, Claude update).",
        ].join("\n"),
        dedup: "global",
      },
    ];
  }
  return [];
}

function detectStallWithoutRecovery(db) {
  // Stalls detected but no continue fired (stall detection works but auto-continue is off or broken)
  const stalls = db
    .prepare(
      `SELECT COUNT(*) as stall_count FROM actions_log
       WHERE action = 'stall_detected' AND created_at >= ?`
    )
    .get(sinceStr);

  const continues = db
    .prepare(
      `SELECT COUNT(*) as cont_count FROM actions_log
       WHERE action IN ('stall_continue_fired', 'stall_continue_skipped') AND created_at >= ?`
    )
    .get(sinceStr);

  const unrecovered = stalls.stall_count - continues.cont_count;
  if (unrecovered >= 5) {
    return [
      {
        type: "stall-no-recovery",
        title: `${unrecovered} stalls with no recovery action in ${HOURS}h`,
        body: [
          `**Stalls detected:** ${stalls.stall_count}`,
          `**Continue actions:** ${continues.cont_count}`,
          `**Unrecovered:** ${unrecovered}`,
          "",
          "Multiple stalls detected without auto-continue. Check if `auto_continue_on_stall` is enabled, or if the detection is too aggressive.",
        ].join("\n"),
        dedup: "global",
      },
    ];
  }
  return [];
}

function detectServerErrors() {
  // Parse error log for unhandled exceptions, SQLITE_BUSY, ENOENT, OOM
  const issues = [];

  for (const logPath of [ERROR_LOG_PATH, LOG_PATH]) {
    if (!fs.existsSync(logPath)) continue;

    const stat = fs.statSync(logPath);
    // Only read last 100KB
    const TAIL = 100 * 1024;
    const start = Math.max(0, stat.size - TAIL);
    const fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf-8");
    const lines = text.split("\n");

    // Patterns to detect
    const patterns = [
      { re: /SQLITE_BUSY/i, type: "sqlite-busy", label: "SQLite BUSY errors" },
      { re: /SQLITE_LOCKED/i, type: "sqlite-locked", label: "SQLite LOCKED errors" },
      { re: /heap out of memory|FATAL ERROR.*allocation/i, type: "oom", label: "Out of memory" },
      { re: /unhandledRejection|uncaughtException/i, type: "unhandled-error", label: "Unhandled exception" },
      { re: /ENOSPC/i, type: "disk-full", label: "Disk full (ENOSPC)" },
      { re: /EMFILE|ENFILE/i, type: "fd-exhaustion", label: "File descriptor exhaustion" },
    ];

    for (const { re, type, label } of patterns) {
      const matches = lines.filter((l) => re.test(l));
      // Only recent lines (rough: check for today's date or yesterday's)
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      const recentMatches = matches.filter(
        (l) => l.includes(today) || l.includes(yesterday)
      );

      if (recentMatches.length >= 3) {
        issues.push({
          type: `log-${type}`,
          title: `${label} detected in server logs (${recentMatches.length} occurrences)`,
          body: [
            `**Pattern:** \`${re.source}\``,
            `**Occurrences:** ${recentMatches.length} (in last ~24h of logs)`,
            `**Log file:** \`${logPath}\``,
            "",
            "**Sample lines:**",
            "```",
            ...recentMatches.slice(0, 5).map((l) => l.slice(0, 300)),
            "```",
          ].join("\n"),
          dedup: type,
        });
      }
    }
  }

  return issues;
}

function detectServiceRestarts() {
  // Too many restarts in the window = something is killing the service
  if (!fs.existsSync(LOG_PATH)) return [];

  const stat = fs.statSync(LOG_PATH);
  const TAIL = 100 * 1024;
  const start = Math.max(0, stat.size - TAIL);
  const fd = fs.openSync(LOG_PATH, "r");
  const buf = Buffer.alloc(Math.min(stat.size, TAIL));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const text = buf.toString("utf-8");

  // Count "Starting Next.js" lines with recent timestamps
  const startLines = text.split("\n").filter(
    (l) => l.includes("Starting Next.js") && l.includes(now.toISOString().slice(0, 10))
  );

  // 10+ restarts is unusual; deploys typically cause 2-3
  if (startLines.length >= 10) {
    return [
      {
        type: "frequent-restarts",
        title: `Service restarted ${startLines.length} times today`,
        body: [
          `**Restart count:** ${startLines.length} (today)`,
          "",
          "The service is restarting frequently. Could be crash-looping, manual deploys, or KeepAlive fighting with something.",
          "",
          "**Recent starts:**",
          "```",
          ...startLines.slice(-5).map((l) => l.slice(0, 200)),
          "```",
        ].join("\n"),
        dedup: "global",
      },
    ];
  }
  return [];
}

// ── Issue creation ──────────────────────────────────────────────────────────────

function createIssue(finding) {
  const labels = "automated,log-analyzer";
  const body = [
    finding.body,
    "",
    "---",
    `_Auto-generated by \`scripts/log-analyzer.js\` at ${now.toISOString()}_`,
    `_Window: last ${HOURS}h (since ${sinceStr})_`,
  ].join("\n");

  if (DRY_RUN) {
    log(`[DRY RUN] Would create issue: "${finding.title}"`);
    log(`  Labels: ${labels}`);
    log(`  Body preview: ${body.slice(0, 200)}...`);
    return true;
  }

  // Write body to temp file to avoid shell escaping issues
  const tmpFile = path.join(__dirname, "..", "data", ".issue-body.tmp");
  try {
    fs.writeFileSync(tmpFile, body);
    execSync(
      `gh issue create --repo "${REPO}" --title "${finding.title.replace(/"/g, '\\"')}" --label "${labels}" --body-file "${tmpFile}"`,
      { stdio: "pipe", timeout: 30000 }
    );
    log(`Created issue: "${finding.title}"`);
    return true;
  } catch (err) {
    log(`Failed to create issue: ${err.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

function main() {
  log(`Starting analysis (window: ${HOURS}h, since: ${sinceStr}, dry-run: ${DRY_RUN})`);

  if (!fs.existsSync(DB_PATH)) {
    log("Database not found, nothing to analyze");
    return;
  }

  const state = loadState();
  const reportedSet = new Set(state.reported_issues || []);

  // Clean old reported keys (older than 24h based on date prefix)
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  state.reported_issues = (state.reported_issues || []).filter(
    (k) => k.startsWith(today) || k.startsWith(yesterday)
  );

  const db = new Database(DB_PATH, { readonly: true });

  // Run all detectors
  const findings = [
    ...detectRepeatCrashers(db),
    ...detectFailedRetries(db),
    ...detectHighCrashRate(db),
    ...detectStallWithoutRecovery(db),
    ...detectServerErrors(),
    ...detectServiceRestarts(),
  ];

  db.close();

  log(`Found ${findings.length} potential issues`);

  let created = 0;
  for (const f of findings) {
    const key = issueKey(f.type, f.dedup);
    if (reportedSet.has(key)) {
      log(`Skipping (already reported today): ${f.title}`);
      continue;
    }

    if (createIssue(f)) {
      state.reported_issues.push(key);
      reportedSet.add(key);
      created++;
    }
  }

  saveState(state);
  log(`Done. Created ${created} issues, skipped ${findings.length - created}.`);
}

main();
