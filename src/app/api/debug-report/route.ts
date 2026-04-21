import { execSync } from "child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import path from "path";
import os from "os";
import { getDb, getAllSettings, getActionsLog, getActionStats } from "@/lib/db";

const SENSITIVE_KEYS = new Set([
  "openai_api_key", "anthropic_api_key", "google_ai_api_key",
  "worker_notify_smtp_pass", "worker_notify_smtp_user",
  "relay_node_id",
]);

function getMaskedSettings(): Record<string, string> {
  const settings = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) {
    masked[k] = SENSITIVE_KEYS.has(k) && v ? `***${v.slice(-4)}` : v;
  }
  return masked;
}

export const dynamic = "force-dynamic";

function safeExec(cmd: string, timeout = 5000): string {
  try {
    return execSync(cmd, { timeout, encoding: "utf-8" }).trim();
  } catch {
    return "(failed)";
  }
}

function getDbStats() {
  try {
    const db = getDb();
    const sessionCount = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    const projectCount = (db.prepare("SELECT COUNT(*) as n FROM projects").get() as { n: number }).n;
    const ftsCount = (db.prepare("SELECT COUNT(*) as n FROM sessions_fts").get() as { n: number }).n;
    const actionsCount = (db.prepare("SELECT COUNT(*) as n FROM actions_log").get() as { n: number }).n;

    const dbPath = path.join(process.cwd(), "data", "sessions.db");
    const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0;
    const walPath = dbPath + "-wal";
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;

    return {
      session_count: sessionCount,
      project_count: projectCount,
      fts_entries: ftsCount,
      actions_log_entries: actionsCount,
      db_size_mb: +(dbSize / 1024 / 1024).toFixed(1),
      wal_size_mb: +(walSize / 1024 / 1024).toFixed(1),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function getSystemInfo() {
  const isWindows = process.platform === "win32";
  return {
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    os_release: os.release(),
    os_type: os.type(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || "unknown",
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
    uptime_hours: +(os.uptime() / 3600).toFixed(1),
    process_memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    process_heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    process_uptime_min: +(process.uptime() / 60).toFixed(1),
    cwd: process.cwd(),
    claude_cli: isWindows
      ? safeExec("where claude")
      : safeExec("which claude"),
    git_version: safeExec("git --version"),
    npm_version: safeExec("npm --version"),
  };
}

function getRecentErrors() {
  // Get last 50 actions that look like errors
  try {
    return getActionsLog({
      limit: 50,
      action: "crash_detected,auto_retry_failed,stall_detected,stall_continue_failed",
    });
  } catch {
    return [];
  }
}

function getSessionsDir() {
  const sessionsDir = path.join(os.homedir(), ".claude", "projects");
  try {
    const entries = readdirSync(sessionsDir);
    return {
      path: sessionsDir,
      exists: true,
      project_count: entries.length,
      entries_sample: entries.slice(0, 10),
    };
  } catch {
    return { path: sessionsDir, exists: false, project_count: 0, entries_sample: [] };
  }
}

function getClientErrors(body: unknown): unknown[] {
  if (body && typeof body === "object" && "client_errors" in body) {
    return (body as { client_errors: unknown[] }).client_errors || [];
  }
  return [];
}

// GET: generate debug report (server-side diagnostics)
export async function GET() {
  const report = {
    generated_at: new Date().toISOString(),
    version: "1.0",
    system: getSystemInfo(),
    database: getDbStats(),
    settings: getMaskedSettings(),
    action_stats_24h: getActionStats(),
    recent_errors: getRecentErrors(),
    sessions_dir: getSessionsDir(),
  };

  return Response.json(report);
}

// POST: receive client-side errors + generate combined report
export async function POST(req: Request) {
  let clientData: Record<string, unknown> = {};
  try {
    clientData = await req.json();
  } catch { /* empty body is ok */ }

  const report = {
    generated_at: new Date().toISOString(),
    version: "1.0",
    system: getSystemInfo(),
    database: getDbStats(),
    settings: getMaskedSettings(),
    action_stats_24h: getActionStats(),
    recent_errors: getRecentErrors(),
    sessions_dir: getSessionsDir(),
    client_errors: getClientErrors(clientData),
    client_info: {
      user_agent: clientData.user_agent || null,
      screen: clientData.screen || null,
      url: clientData.url || null,
      performance: clientData.performance || null,
    },
  };

  return Response.json(report);
}
