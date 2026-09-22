/**
 * Read-only accessor for OpenCode's own SQLite database at
 * ~/.local/share/opencode/opencode.db.
 *
 * OpenCode sessions are invisible to Session Manager unless we read this
 * DB — unlike Claude (JSONL files we scan) and Codex (its own SQLite, see
 * codex-db.ts), nothing here previously discovered OpenCode sessions at
 * all, so `agent: "opencode"` starts from the UI never got a session_id
 * back and never appeared in the sidebar. Never writes to OpenCode's DB.
 */
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";

const OPENCODE_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

let _opencodeDb: Database.Database | null = null;

function getOpencodeDb(): Database.Database | null {
  if (_opencodeDb) return _opencodeDb;
  try {
    if (!fs.existsSync(OPENCODE_DB_PATH)) return null;
    _opencodeDb = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
    return _opencodeDb;
  } catch {
    return null;
  }
}

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
}

/** Lists OpenCode sessions, newest first. Empty if the DB is missing or unreadable. */
export function listOpencodeSessions(directory?: string): OpencodeSessionRow[] {
  const db = getOpencodeDb();
  if (!db) return [];
  try {
    if (directory) {
      return db
        .prepare(
          `SELECT id, directory, title, time_created, time_updated
           FROM session WHERE directory = ? ORDER BY time_created DESC`
        )
        .all(directory) as OpencodeSessionRow[];
    }
    return db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated
         FROM session ORDER BY time_created DESC`
      )
      .all() as OpencodeSessionRow[];
  } catch {
    return [];
  }
}

/** First user message text for a session, if any (from the `part` table's text parts). */
export function getOpencodeFirstUserMessage(sessionId: string): string | null {
  const db = getOpencodeDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT p.data FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user'
         ORDER BY p.time_created ASC LIMIT 1`
      )
      .get(sessionId) as { data: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data) as { type?: string; text?: string };
    return parsed.type === "text" ? parsed.text ?? null : null;
  } catch {
    return null;
  }
}
