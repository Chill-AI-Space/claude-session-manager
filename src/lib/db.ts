import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "sessions.db");
const SETTINGS_DIR = path.join(os.homedir(), ".config", "claude-session-manager");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    // Auto-checkpoint when WAL grows beyond 4MB (default is 1000 pages ≈ 4MB)
    // This prevents WAL from growing to 70MB+ and consuming memory via mmap
    _db.pragma("wal_autocheckpoint = 1000");
    initTables(_db);
    // Checkpoint any accumulated WAL from previous runs
    try { _db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* non-critical */ }
  }
  return _db;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      jsonl_path TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      project_path TEXT NOT NULL,
      git_branch TEXT,
      claude_version TEXT,
      model TEXT,
      first_prompt TEXT,
      last_message TEXT,
      generated_title TEXT,
      message_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      custom_name TEXT,
      tags TEXT,
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      last_scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_dir TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      display_name TEXT,
      session_count INTEGER DEFAULT 0,
      last_activity TEXT,
      custom_name TEXT,
      color TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
    CREATE INDEX IF NOT EXISTS idx_sessions_modified ON sessions(modified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned DESC, modified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(archived, pinned DESC, modified_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS actions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_actions_log_created ON actions_log(created_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      session_id TEXT,
      project_path TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, created_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      slug TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      password TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_share_links_session ON share_links(session_id);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      content,
      tokenize='unicode61 remove_diacritics 1'
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS autodetect_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT,
      chosen_path TEXT,
      chosen_name TEXT,
      keyword_rank INTEGER,
      gemini_rank INTEGER,
      keyword_top5 TEXT,
      gemini_top5 TEXT,
      keyword_all_scores TEXT,
      gemini_raw TEXT,
      gemini_method TEXT,
      total_projects INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_autodetect_log_created ON autodetect_log(created_at DESC);
  `);

  // ── Workers + Worker Tasks ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      project_domain TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'offline',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT,
      heartbeat_interval_ms INTEGER NOT NULL DEFAULT 30000,
      missed_heartbeats INTEGER DEFAULT 0,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workers_domain ON workers(project_domain);
    CREATE INDEX IF NOT EXISTS idx_workers_phase ON workers(phase);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      project_domain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      task_prompt TEXT,
      dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      fallback_used TEXT,
      result_summary TEXT,
      contact_email TEXT,
      FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_worker ON worker_tasks(worker_id, status);
    CREATE INDEX IF NOT EXISTS idx_worker_tasks_domain ON worker_tasks(project_domain, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_source_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES context_source_groups(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS context_group_projects (
      group_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      PRIMARY KEY (group_id, pattern),
      FOREIGN KEY (group_id) REFERENCES context_source_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_context_sources_group ON context_sources(group_id);
  `);

  // Migrations: add columns that may not exist in older DBs
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("last_message")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_message TEXT");
  }
  if (!colNames.has("generated_title")) {
    db.exec("ALTER TABLE sessions ADD COLUMN generated_title TEXT");
  }
  if (!colNames.has("embedding")) {
    db.exec("ALTER TABLE sessions ADD COLUMN embedding BLOB");
  }
  if (!colNames.has("last_message_role")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_message_role TEXT");
  }
  if (!colNames.has("titled_at_count")) {
    db.exec("ALTER TABLE sessions ADD COLUMN titled_at_count INTEGER DEFAULT 0");
  }
  if (!colNames.has("has_result")) {
    db.exec("ALTER TABLE sessions ADD COLUMN has_result INTEGER DEFAULT 0");
  }
  if (!colNames.has("summary")) {
    db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
  }
  if (!colNames.has("learnings")) {
    db.exec("ALTER TABLE sessions ADD COLUMN learnings TEXT");
  }
  // actions_log migrations
  const actionCols = db.prepare("PRAGMA table_info(actions_log)").all() as { name: string }[];
  const actionColNames = new Set(actionCols.map((c) => c.name));
  if (!actionColNames.has("payload")) {
    db.exec("ALTER TABLE actions_log ADD COLUMN payload TEXT");
  }
}

export interface ActionLogEntry {
  id: number;
  type: "service" | "settings";
  action: string;
  details: string | null;
  session_id: string | null;
  payload: string | null;
  created_at: string;
}

export function logAction(
  type: "service" | "settings",
  action: string,
  details?: string,
  sessionId?: string,
  payload?: string
): void {
  // Also emit to debug stream for real-time monitoring
  try {
    const { info, warn } = require("./debug-logger");
    const level = action.includes("fail") || action.includes("crash") || action.includes("error") ? warn : info;
    level("action", `${action}${details ? `: ${details}` : ""}`, {
      type, action, details, sessionId,
    });
  } catch { /* debug-logger not available */ }

  try {
    getDb()
      .prepare(
        "INSERT INTO actions_log (type, action, details, session_id, payload) VALUES (?, ?, ?, ?, ?)"
      )
      .run(type, action, details ?? null, sessionId ?? null, payload ?? null);
  } catch {
    // Non-critical — don't break the main flow
  }
}

export function indexSessionContent(sessionId: string, text: string): void {
  try {
    const db = getDb();
    db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(sessionId);
    if (text.trim()) {
      db.prepare("INSERT INTO sessions_fts(session_id, content) VALUES (?, ?)").run(sessionId, text);
    }
  } catch { /* Non-critical */ }
}

export function searchSessionContent(query: string): string[] {
  try {
    const db = getDb();
    // Escape FTS5 special chars and wrap in quotes for phrase-safe matching
    const escaped = query.replace(/"/g, '""');
    const rows = db
      .prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank LIMIT 100")
      .all(`"${escaped}"`) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  } catch {
    return [];
  }
}

export interface ShareLink {
  slug: string;
  session_id: string;
  password: string;
  url: string;
  created_at: string;
}

export function getShareLink(sessionId: string): ShareLink | null {
  return (
    getDb()
      .prepare("SELECT * FROM share_links WHERE session_id = ? LIMIT 1")
      .get(sessionId) as ShareLink | undefined
  ) ?? null;
}

export function upsertShareLink(sessionId: string, slug: string, password: string, url: string): void {
  getDb()
    .prepare(
      `INSERT INTO share_links (slug, session_id, password, url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET url=excluded.url`
    )
    .run(slug, sessionId, password, url);
}

export function deleteShareLink(sessionId: string): void {
  getDb().prepare("DELETE FROM share_links WHERE session_id = ?").run(sessionId);
}

export function getActionsLog(opts: {
  limit?: number;
  action?: string;
  sessionId?: string;
  type?: string;
  since?: string;
} = {}): ActionLogEntry[] {
  const { limit = 500, action, sessionId, type, since } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (action) {
    const actions = action.split(",").map(a => a.trim()).filter(Boolean);
    if (actions.length > 0) {
      conditions.push(`action IN (${actions.map(() => "?").join(",")})`);
      params.push(...actions);
    }
  }
  if (sessionId) {
    conditions.push("session_id = ?");
    params.push(sessionId);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  if (since) {
    conditions.push("created_at >= ?");
    params.push(since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  return getDb()
    .prepare(`SELECT * FROM actions_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as ActionLogEntry[];
}

export interface ActionStats {
  total_24h: number;
  crashes_24h: number;
  retries_24h: number;
  retries_failed_24h: number;
  stalls_24h: number;
  replies_24h: number;
  last_crash: string | null;
  last_action: string | null;
}

export function getActionStats(): ActionStats {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN action = 'crash_detected' THEN 1 ELSE 0 END) as crashes,
      SUM(CASE WHEN action IN ('auto_retry_fired','stall_continue_fired') THEN 1 ELSE 0 END) as retries,
      SUM(CASE WHEN action IN ('auto_retry_failed','stall_continue_failed') THEN 1 ELSE 0 END) as retries_failed,
      SUM(CASE WHEN action = 'stall_detected' THEN 1 ELSE 0 END) as stalls,
      SUM(CASE WHEN action = 'reply' THEN 1 ELSE 0 END) as replies,
      MAX(CASE WHEN action = 'crash_detected' THEN created_at END) as last_crash,
      MAX(created_at) as last_action
    FROM actions_log WHERE created_at >= ?
  `).get(since) as Record<string, number | string | null>;

  return {
    total_24h: (row.total as number) ?? 0,
    crashes_24h: (row.crashes as number) ?? 0,
    retries_24h: (row.retries as number) ?? 0,
    retries_failed_24h: (row.retries_failed as number) ?? 0,
    stalls_24h: (row.stalls as number) ?? 0,
    replies_24h: (row.replies as number) ?? 0,
    last_crash: (row.last_crash as string) ?? null,
    last_action: (row.last_action as string) ?? null,
  };
}

const SETTING_DEFAULTS: Record<string, string> = {
  auto_retry_on_crash: "true",
  auto_continue_on_stall: "false",
  auto_kill_terminal_on_reply: "false",
  dangerously_skip_permissions: "false",
  vector_search_top_k: "20",
  new_session_from_reply: "true",
  debug_mode: "false",
  debug_log_endpoint: "",
  // Orchestrator settings
  orchestrator_max_concurrent: "3",
  orchestrator_crash_retry_delay_ms: "30000",
  orchestrator_stall_continue_delay_ms: "10000",
  orchestrator_max_retries: "3",
  // Permission wait detection — auto kill+resume when Claude is stuck on tool approval
  auto_escalate_permissions: "true",
  permission_wait_threshold_ms: "120000",
  // Interval (ms) for periodic permission-wait checker (0 = disabled)
  permission_check_interval_ms: "180000",
  // Test word: if set and found in last assistant text, triggers permission escalation (for testing)
  permission_escalation_test_word: "",
  // Auto-close terminal windows after permission escalation completes
  auto_close_escalation_terminals: "true",
  // Claude CLI model (used for terminal sessions)
  claude_model: "claude-sonnet-4-6",
  // Remote relay settings
  relay_enabled: "false",
  relay_node_id: "",
  relay_server_url: "wss://csm-relay.chillai.workers.dev",
  // Remote nodes registry (JSON array)
  remote_nodes: "[]",
  // Default compute node — if set, new sessions run on this remote node
  default_compute_node: "",
  // Title generation (uses summary as input)
  title_model: "gpt-4o-mini",
  // Summary & learnings generation (direct API, no CLI sessions spawned)
  summary_model: "gpt-4o-mini",
  summary_incremental_model: "gemini-2.5-flash",
  learnings_model: "gpt-4o-mini",
  auto_generate_summary: "true",
  auto_generate_learnings: "true",
  openai_api_key: "",
  anthropic_api_key: "",
  google_ai_api_key: "",
  zai_api_key: "",
  zai_base_url: "",
  // Worker integration
  worker_heartbeat_timeout_ms: "300000",
  worker_fallback_enabled: "true",
  worker_fallback_model: "claude-sonnet-4-6",
  worker_fallback_use_vertex: "false",
  worker_fallback_vertex_project: "",
  worker_fallback_vertex_region: "us-east5",
  worker_notify_smtp_host: "",
  worker_notify_smtp_port: "587",
  worker_notify_smtp_user: "",
  worker_notify_smtp_pass: "",
  worker_notify_from: "",
  worker_notify_to: "",
  worker_notify_webhook_url: "",
};

// Settings cache — avoids reading JSON file on every getSetting() call
let _settingsCache: Record<string, string> | null = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 2000; // 2 seconds

function readSettingsFile(): Record<string, string> {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheTime < SETTINGS_CACHE_TTL) {
    return _settingsCache;
  }
  try {
    const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
    _settingsCache = JSON.parse(data);
    _settingsCacheTime = now;
    return _settingsCache!;
  } catch {
    _settingsCache = {};
    _settingsCacheTime = now;
    return {};
  }
}

function writeSettingsFile(settings: Record<string, string>): void {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  // Write atomically: write to temp file, then rename
  const tmpPath = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, SETTINGS_PATH);
  // Bust cache
  _settingsCache = settings;
  _settingsCacheTime = Date.now();
}

export function getSetting(key: string): string {
  const saved = readSettingsFile();
  return saved[key] ?? SETTING_DEFAULTS[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  // Invalidate cache before re-read to get fresh data for read-modify-write
  _settingsCache = null;
  const saved = readSettingsFile();
  saved[key] = value;
  writeSettingsFile(saved);
}

export function getAllSettings(): Record<string, string> {
  const saved = readSettingsFile();
  return { ...SETTING_DEFAULTS, ...saved };
}

// ── Issues ──────────────────────────────────────────────────────────────────────

export type IssueCategory =
  | "critical_problem"
  | "repeated_bug"
  | "one_time_bug"
  | "idea"
  | "must_have_feature";

export interface IssueRow {
  id: number;
  category: IssueCategory;
  description: string;
  session_id: string | null;
  project_path: string | null;
  status: "new" | "seen" | "resolved";
  created_at: string;
}

const ISSUES_JSONL = path.join(process.cwd(), "data", "issues.jsonl");

export function createIssue(issue: {
  category: IssueCategory;
  description: string;
  session_id?: string;
  project_path?: string;
}): IssueRow {
  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO issues (category, description, session_id, project_path) VALUES (?, ?, ?, ?)"
    )
    .run(issue.category, issue.description, issue.session_id ?? null, issue.project_path ?? null);

  const row = db.prepare("SELECT * FROM issues WHERE id = ?").get(result.lastInsertRowid) as IssueRow;

  // Also append to JSONL for cron consumption
  try {
    fs.appendFileSync(ISSUES_JSONL, JSON.stringify(row) + "\n");
  } catch { /* non-critical */ }

  return row;
}

export function getIssues(opts: { status?: string; limit?: number } = {}): IssueRow[] {
  const { status, limit = 100 } = opts;
  if (status) {
    return getDb()
      .prepare("SELECT * FROM issues WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(status, limit) as IssueRow[];
  }
  return getDb()
    .prepare("SELECT * FROM issues ORDER BY created_at DESC LIMIT ?")
    .all(limit) as IssueRow[];
}

export function updateIssueStatus(id: number, status: "new" | "seen" | "resolved"): void {
  getDb().prepare("UPDATE issues SET status = ? WHERE id = ?").run(status, id);
}
