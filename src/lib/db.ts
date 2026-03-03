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
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initTables(_db);
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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
}

const SETTING_DEFAULTS: Record<string, string> = {
  auto_kill_terminal_on_reply: "false",
  dangerously_skip_permissions: "false",
  vector_search_top_k: "20",
};

function readSettingsFile(): Record<string, string> {
  try {
    const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function writeSettingsFile(settings: Record<string, string>): void {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export function getSetting(key: string): string {
  const saved = readSettingsFile();
  return saved[key] ?? SETTING_DEFAULTS[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  const saved = readSettingsFile();
  saved[key] = value;
  writeSettingsFile(saved);
}

export function getAllSettings(): Record<string, string> {
  const saved = readSettingsFile();
  return { ...SETTING_DEFAULTS, ...saved };
}
