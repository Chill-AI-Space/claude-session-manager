import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";

// Use a temp DB so tests don't touch the real data
const TEST_DB_PATH = path.join(os.tmpdir(), `csm-test-${Date.now()}.db`);
const TEST_SETTINGS_DIR = path.join(os.tmpdir(), `csm-settings-${Date.now()}`);
const TEST_SETTINGS_PATH = path.join(TEST_SETTINGS_DIR, "settings.json");

// We can't easily mock the module-level singletons in db.ts,
// so we test the DB schema and queries directly using better-sqlite3
describe("database schema", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(TEST_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Replicate initTables from db.ts
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
        last_scanned_at TEXT NOT NULL,
        last_message_role TEXT,
        titled_at_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
      CREATE INDEX IF NOT EXISTS idx_sessions_modified ON sessions(modified_at DESC);

      CREATE TABLE IF NOT EXISTS projects (
        project_dir TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        display_name TEXT,
        session_count INTEGER DEFAULT 0,
        last_activity TEXT,
        custom_name TEXT,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS actions_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        session_id TEXT,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        session_id TEXT,
        project_path TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS share_links (
        slug TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        password TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED,
        content,
        tokenize='unicode61 remove_diacritics 1'
      );
    `);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
  });

  it("creates all expected tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("sessions");
    expect(names).toContain("projects");
    expect(names).toContain("actions_log");
    expect(names).toContain("issues");
    expect(names).toContain("share_links");
  });

  it("inserts and retrieves a session", () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, created_at, modified_at, file_mtime, file_size, last_scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("test-001", "/tmp/test.jsonl", "/proj", "/Users/test/proj", now, now, 1000, 500, now);

    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("test-001") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.session_id).toBe("test-001");
    expect(row.project_dir).toBe("/proj");
    expect(row.pinned).toBe(0);
    expect(row.archived).toBe(0);
  });

  it("filters archived sessions", () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, created_at, modified_at, file_mtime, file_size, last_scanned_at, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("test-archived", "/tmp/arch.jsonl", "/proj", "/Users/test/proj", now, now, 1000, 500, now, 1);

    const active = db.prepare("SELECT * FROM sessions WHERE archived = 0").all() as Record<string, unknown>[];
    const all = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];

    expect(all.length).toBeGreaterThan(active.length);
    expect(active.every((r) => r.archived === 0)).toBe(true);
  });

  it("sorts by modified_at DESC", () => {
    const rows = db
      .prepare("SELECT session_id, modified_at FROM sessions WHERE archived = 0 ORDER BY pinned DESC, modified_at DESC")
      .all() as { session_id: string; modified_at: string }[];

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].modified_at >= rows[i].modified_at).toBe(true);
    }
  });

  it("search by first_prompt LIKE", () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, first_prompt, created_at, modified_at, file_mtime, file_size, last_scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("test-search", "/tmp/s.jsonl", "/proj", "/Users/test/proj", "fix the authentication bug", now, now, 1000, 500, now);

    const rows = db
      .prepare("SELECT * FROM sessions WHERE first_prompt LIKE ?")
      .all("%authentication%") as Record<string, unknown>[];

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].session_id).toBe("test-search");
  });

  it("FTS5 search works", () => {
    db.prepare("INSERT INTO sessions_fts(session_id, content) VALUES (?, ?)").run(
      "test-fts",
      "refactoring the database connection pool for better performance"
    );

    const results = db
      .prepare('SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ? LIMIT 10')
      .all('"database connection"') as { session_id: string }[];

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].session_id).toBe("test-fts");
  });

  it("logs actions", () => {
    db.prepare(
      "INSERT INTO actions_log (type, action, details, session_id) VALUES (?, ?, ?, ?)"
    ).run("service", "crash_detected", "process exited", "test-001");

    const log = db
      .prepare("SELECT * FROM actions_log WHERE session_id = ? ORDER BY created_at DESC")
      .all("test-001") as Record<string, unknown>[];

    expect(log.length).toBe(1);
    expect(log[0].action).toBe("crash_detected");
  });

  it("creates and retrieves issues", () => {
    const result = db
      .prepare("INSERT INTO issues (category, description, session_id) VALUES (?, ?, ?)")
      .run("critical_problem", "API crashes on empty payload", "test-001");

    const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>;
    expect(issue.category).toBe("critical_problem");
    expect(issue.status).toBe("new");
  });

  it("upserts share links", () => {
    db.prepare(`
      INSERT INTO share_links (slug, session_id, password, url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET url=excluded.url
    `).run("my-share", "test-001", "secret123", "https://example.com/share/my-share");

    const link = db.prepare("SELECT * FROM share_links WHERE slug = ?").get("my-share") as Record<string, unknown>;
    expect(link.session_id).toBe("test-001");
    expect(link.password).toBe("secret123");

    // Upsert with new URL
    db.prepare(`
      INSERT INTO share_links (slug, session_id, password, url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET url=excluded.url
    `).run("my-share", "test-001", "secret123", "https://example.com/share/my-share-v2");

    const updated = db.prepare("SELECT * FROM share_links WHERE slug = ?").get("my-share") as Record<string, unknown>;
    expect(updated.url).toBe("https://example.com/share/my-share-v2");
  });
});

describe("settings (file-based)", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_SETTINGS_DIR, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(TEST_SETTINGS_DIR, { recursive: true }); } catch {}
  });

  it("reads empty settings when file does not exist", () => {
    const nonExistent = path.join(TEST_SETTINGS_DIR, "nope.json");
    let settings: Record<string, string> = {};
    try {
      settings = JSON.parse(fs.readFileSync(nonExistent, "utf-8"));
    } catch {
      settings = {};
    }
    expect(settings).toEqual({});
  });

  it("writes and reads settings atomically", () => {
    const data = { auto_retry_on_crash: "false", debug_mode: "true" };
    const tmpPath = TEST_SETTINGS_PATH + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, TEST_SETTINGS_PATH);

    const read = JSON.parse(fs.readFileSync(TEST_SETTINGS_PATH, "utf-8"));
    expect(read.auto_retry_on_crash).toBe("false");
    expect(read.debug_mode).toBe("true");
  });

  it("merges defaults with saved settings", () => {
    const DEFAULTS: Record<string, string> = {
      auto_retry_on_crash: "true",
      debug_mode: "false",
      vector_search_top_k: "20",
    };
    const saved = JSON.parse(fs.readFileSync(TEST_SETTINGS_PATH, "utf-8"));
    const merged = { ...DEFAULTS, ...saved };

    expect(merged.auto_retry_on_crash).toBe("false"); // overridden
    expect(merged.debug_mode).toBe("true"); // overridden
    expect(merged.vector_search_top_k).toBe("20"); // default
  });
});
