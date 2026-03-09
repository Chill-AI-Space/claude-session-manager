import Database from "better-sqlite3";
import path from "path";

const ANALYTICS_DB_PATH = path.join(process.cwd(), "data", "analytics.db");

let _adb: Database.Database | null = null;

export function getAnalyticsDb(): Database.Database {
  if (!_adb) {
    _adb = new Database(ANALYTICS_DB_PATH, { readonly: true });
    _adb.pragma("journal_mode = WAL");
  }
  return _adb;
}

// Reports are stored in the main sessions.db (writable)
import { getDb } from "./db";

export function initReportsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS analytics_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id TEXT NOT NULL,
      title TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reports_created ON analytics_reports(created_at DESC);
  `);
}

export function saveReport(queryId: string, title: string, dataJson: string): number {
  initReportsTable();
  const r = getDb().prepare(
    "INSERT INTO analytics_reports (query_id, title, data_json) VALUES (?, ?, ?)"
  ).run(queryId, title, dataJson);
  return r.lastInsertRowid as number;
}

export interface ReportRow {
  id: number;
  query_id: string;
  title: string;
  data_json: string;
  created_at: string;
}

export function getRecentReports(limit = 20): ReportRow[] {
  initReportsTable();
  return getDb()
    .prepare("SELECT * FROM analytics_reports ORDER BY created_at DESC LIMIT ?")
    .all(limit) as ReportRow[];
}
