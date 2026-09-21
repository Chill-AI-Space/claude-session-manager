import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { listProjectsFromSessions, syncProjectsFromSessions } from "../projects";

function initTestDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      jsonl_path TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      project_path TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE projects (
      project_dir TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      display_name TEXT,
      session_count INTEGER DEFAULT 0,
      last_activity TEXT,
      custom_name TEXT,
      color TEXT
    );
  `);
}

describe("project aggregation", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `csm-projects-${Date.now()}-${Math.random()}.db`);
    db = new Database(dbPath);
    initTestDb(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  });

  it("lists projects that only exist in sessions", () => {
    db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, modified_at, archived)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "codex-1",
      "/tmp/codex.jsonl",
      "-Users-vova-Documents-GitHub-codex-only",
      "/Users/vova/Documents/GitHub/codex-only",
      "2026-05-06T10:00:00.000Z",
      0
    );

    const projects = listProjectsFromSessions(db);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      project_dir: "-Users-vova-Documents-GitHub-codex-only",
      project_path: "/Users/vova/Documents/GitHub/codex-only",
      display_name: "codex-only",
      session_count: 1,
    });
  });

  it("preserves project custom metadata while using active session stats", () => {
    db.prepare(`
      INSERT INTO projects (project_dir, project_path, display_name, custom_name, color)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "-Users-vova-Documents-GitHub-app",
      "/Users/vova/Documents/GitHub/app",
      "app",
      "Client App",
      "#14b8a6"
    );

    const insertSession = db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, modified_at, archived)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertSession.run("active-1", "/tmp/1.jsonl", "-Users-vova-Documents-GitHub-app", "/Users/vova/Documents/GitHub/app", "2026-05-06T10:00:00.000Z", 0);
    insertSession.run("archived-1", "/tmp/2.jsonl", "-Users-vova-Documents-GitHub-app", "/Users/vova/Documents/GitHub/app", "2026-05-06T11:00:00.000Z", 1);

    const projects = listProjectsFromSessions(db);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      display_name: "Client App",
      custom_name: "Client App",
      color: "#14b8a6",
      session_count: 1,
      last_activity: "2026-05-06T10:00:00.000Z",
    });
  });

  it("syncs missing session projects back into the projects table", () => {
    db.prepare(`
      INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, modified_at, archived)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "forge-1",
      "forge://one",
      "-Users-vova-Documents-GitHub-forge-only",
      "/Users/vova/Documents/GitHub/forge-only",
      "2026-05-06T10:00:00.000Z",
      0
    );

    expect(syncProjectsFromSessions(db)).toBe(1);

    const row = db.prepare("SELECT * FROM projects WHERE project_dir = ?").get(
      "-Users-vova-Documents-GitHub-forge-only"
    ) as Record<string, unknown> | undefined;

    expect(row).toMatchObject({
      project_path: "/Users/vova/Documents/GitHub/forge-only",
      display_name: "forge-only",
      session_count: 1,
      last_activity: "2026-05-06T10:00:00.000Z",
    });
  });
});
