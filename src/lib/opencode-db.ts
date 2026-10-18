/**
 * Read-only accessor for OpenCode's own SQLite databases at
 * ~/.local/share/opencode/*.db.
 *
 * OpenCode creates multiple databases per profile/instance.
 * This module now discovers all *.db files and exposes a way
 * to iterate sessions across all of them.
 */

import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import type { ContentBlock, ParsedMessage } from "./types";

const OPENCODE_DIR = path.join(os.homedir(), ".local", "share", "opencode");

let _opencodeDb: Database.Database | null = null;

/** All open DB connections, keyed by path. Opened read-only, kept for process lifetime. */
const _dbsByPath = new Map<string, Database.Database | null>();

function openDb(dbPath: string): Database.Database | null {
  const cached = _dbsByPath.get(dbPath);
  if (cached !== undefined) return cached;
  let db: Database.Database | null = null;
  try {
    if (fs.existsSync(dbPath)) {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    }
  } catch {
    db = null;
  }
  // Only cache successful connections; a missing/unreadable file may appear later.
  if (db) _dbsByPath.set(dbPath, db);
  return db;
}

function getOpencodeDb(): Database.Database | null {
  if (_opencodeDb) return _opencodeDb;
  const db = openDb(path.join(OPENCODE_DIR, "opencode.db"));
  if (db) _opencodeDb = db;
  return db;
}

function listOpencodeDbPaths(): string[] {
  try {
    return fs.readdirSync(OPENCODE_DIR)
      .filter((f) => f.endsWith(".db"))
      .map((f) => path.join(OPENCODE_DIR, f));
  } catch {
    return [];
  }
}

/** Find which DB file contains a given session ID. Opens each DB read-only briefly. */
function findDbWithSession(sessionId: string): Database.Database | null {
  for (const dbPath of listOpencodeDbPaths()) {
    const db = openDb(dbPath);
    if (!db) continue;
    try {
      const row = db.prepare(`SELECT 1 FROM session WHERE id = ? LIMIT 1`).get(sessionId);
      if (row) return db;
    } catch {
      // ignore, try next
    }
  }
  return null;
}

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
}

/** Lists OpenCode sessions, newest first, across ALL databases. Empty if none unreadable. */
export function listOpencodeSessions(directory?: string): OpencodeSessionRow[] {
  const seen = new Map<string, OpencodeSessionRow>();
  for (const dbPath of listOpencodeDbPaths()) {
    const db = openDb(dbPath);
    if (!db) continue;
    try {
      const stmt = directory
        ? db.prepare(`SELECT id, directory, title, time_created, time_updated FROM session WHERE directory = ?`)
        : db.prepare(`SELECT id, directory, title, time_created, time_updated FROM session`);
      const rows = (directory ? stmt.all(directory) : stmt.all()) as OpencodeSessionRow[];
      for (const row of rows) {
        const existing = seen.get(row.id);
        if (!existing || row.time_updated > existing.time_updated) seen.set(row.id, row);
      }
    } catch {
      // unreadable DB — skip
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.time_created - a.time_created);
}

/** Session row as the background scanner needs it — top-level sessions only. */
export interface OpencodeIndexRow {
  id: string;
  directory: string;
  title: string;
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
  /** Raw `session.model` JSON (`{"id":…,"providerID":…}`) — parse with opencodeModelLabel. */
  model: string | null;
  tokens_input: number;
  tokens_output: number;
}

/**
 * Lists sessions worth indexing into our `sessions` table: top-level only
 * (`parent_id IS NULL` — subagent children are not sidebar sessions) and not
 * archived (`time_archived IS NULL`). Scans ALL OpenCode databases and
 * deduplicates by session ID (keeps most recent).
 */
export function listIndexableOpencodeSessions(): OpencodeIndexRow[] {
  const dbPaths = listOpencodeDbPaths();
  if (dbPaths.length === 0) return [];

  const seen = new Map<string, OpencodeIndexRow>();

  for (const dbPath of dbPaths) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          `SELECT id, directory, title, time_created, time_updated, model, tokens_input, tokens_output
           FROM session
           WHERE parent_id IS NULL AND time_archived IS NULL
           ORDER BY time_updated DESC`
        )
        .all() as OpencodeIndexRow[];

      for (const row of rows) {
        const existing = seen.get(row.id);
        if (!existing || row.time_updated > existing.time_updated) {
          seen.set(row.id, row);
        }
      }
    } catch {
      continue;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  // Sort by time_updated descending
  return Array.from(seen.values()).sort((a, b) => b.time_updated - a.time_updated);
}

/** `{"id":"mimo-v2.6-flash","providerID":"opencode-go"}` → `opencode-go/mimo-v2.6-flash`. */
export function opencodeModelLabel(modelJson: string | null | undefined): string | null {
  if (!modelJson) return null;
  try {
    const m = JSON.parse(modelJson) as { id?: string; providerID?: string };
    if (m?.id && m?.providerID) return `${m.providerID}/${m.id}`;
    return m?.id ?? null;
  } catch {
    return null;
  }
}

/** Light per-session text the scanner stores (never a full transcript read). */
export interface OpencodeSessionIndexText {
  firstPrompt: string | null;
  lastMessage: string | null;
  lastMessageRole: string | null;
  messageCount: number;
}

function parsePartText(raw: string): string | null {
  try {
    const p = JSON.parse(raw) as OpencodePartData;
    if (p.type === "text" && p.text?.trim()) return p.text;
  } catch {
    /* malformed part — skip */
  }
  return null;
}

/**
 * First prompt / last text message / message count for one session.
 * All queries ride existing indexes (`message_session_time_created_id_idx`,
 * `part_message_id_id_idx`) with small LIMITs — never a full transcript read,
 * so a scan of every session can't walk OpenCode's multi-GB DB.
 */
export function getOpencodeSessionIndexText(sessionId: string): OpencodeSessionIndexText | null {
  const db = findDbWithSession(sessionId) ?? getOpencodeDb();
  if (!db) return null;

  try {
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM message WHERE session_id = ?`)
      .get(sessionId) as { c: number };

    let firstPrompt: string | null = null;
    const firstUser = db
      .prepare(
        `SELECT id FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
         ORDER BY time_created ASC, id ASC LIMIT 1`
      )
      .get(sessionId) as { id: string } | undefined;
    if (firstUser) {
      const parts = db
        .prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC LIMIT 10`)
        .all(firstUser.id) as { data: string }[];
      for (const part of parts) {
        const text = parsePartText(part.data);
        if (text) {
          firstPrompt = text;
          break;
        }
      }
    }

    let lastMessage: string | null = null;
    let lastMessageRole: string | null = null;
    const recentMessages = db
      .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 6`)
      .all(sessionId) as { id: string; data: string }[];
    for (const msg of recentMessages) {
      let role: string | null = null;
      try {
        role = (JSON.parse(msg.data) as { role?: string }).role ?? null;
      } catch {
        /* skip */
      }
      const parts = db
        .prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC`)
        .all(msg.id) as { data: string }[];
      const texts: string[] = [];
      for (const part of parts) {
        const text = parsePartText(part.data);
        if (text) texts.push(text);
      }
      if (texts.length > 0) {
        lastMessage = texts.join("\n");
        lastMessageRole = role;
        break;
      }
    }

    return {
      firstPrompt,
      lastMessage,
      lastMessageRole,
      messageCount: countRow?.c ?? 0,
    };
  } catch {
    return null;
  }
}

/** Single session row by id, or null if the DB is missing or the id doesn't exist. */
export function getOpencodeSession(sessionId: string): OpencodeSessionRow | null {
  const db = findDbWithSession(sessionId) ?? getOpencodeDb();
  if (!db) return null;
  try {
    return (
      db
        .prepare(`SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?`)
        .get(sessionId) as OpencodeSessionRow | undefined
    ) ?? null;
  } catch {
    return null;
  }
}

interface OpencodeMessageData {
  role?: string;
  modelID?: string;
  providerID?: string;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
}

interface OpencodePartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
}

/**
 * Reads every message in an OpenCode session, converted to the same
 * ParsedMessage shape the UI already renders for Claude/Codex/Forge.
 * OpenCode splits a turn into a `message` row (role + model/usage) plus
 * several `part` rows (text/reasoning/tool-call parts) — this flattens
 * those into ParsedMessage.content blocks. Only handles the part types
 * that carry visible content (text, reasoning, tool); step markers,
 * file/patch/compaction parts are skipped for now.
 */
export function readOpencodeMessages(sessionId: string): ParsedMessage[] {
  const db = findDbWithSession(sessionId) ?? getOpencodeDb();
  if (!db) return [];
  try {
    const messageRows = db
      .prepare(`SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC`)
      .all(sessionId) as { id: string; data: string; time_created: number }[];
    const partRows = db
      .prepare(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC`)
      .all(sessionId) as { message_id: string; data: string }[];

    const partsByMessage = new Map<string, string[]>();
    for (const p of partRows) {
      const arr = partsByMessage.get(p.message_id) ?? [];
      arr.push(p.data);
      partsByMessage.set(p.message_id, arr);
    }

    const messages: ParsedMessage[] = [];
    for (const row of messageRows) {
      let msgData: OpencodeMessageData;
      try {
        msgData = JSON.parse(row.data);
      } catch {
        continue;
      }

      const blocks: ContentBlock[] = [];
      for (const raw of partsByMessage.get(row.id) ?? []) {
        let pd: OpencodePartData;
        try {
          pd = JSON.parse(raw);
        } catch {
          continue;
        }
        if (pd.type === "text" && pd.text?.trim()) {
          blocks.push({ type: "text", text: pd.text });
        } else if (pd.type === "reasoning" && pd.text?.trim()) {
          blocks.push({ type: "thinking", thinking: pd.text });
        } else if (pd.type === "tool" && pd.callID) {
          blocks.push({ type: "tool_use", id: pd.callID, name: pd.tool ?? "tool", input: pd.state?.input ?? {} });
          if (pd.state?.status === "completed" || pd.state?.status === "error") {
            blocks.push({
              type: "tool_result",
              tool_use_id: pd.callID,
              content: pd.state.output ?? pd.state.error ?? "",
            });
          }
        }
      }

      if (msgData.role === "assistant") {
        if (blocks.length === 0) continue; // still streaming / no output yet
        messages.push({
          uuid: row.id,
          type: "assistant",
          timestamp: new Date(row.time_created).toISOString(),
          content: blocks,
          model: msgData.modelID
            ? msgData.providerID
              ? `${msgData.providerID}/${msgData.modelID}`
              : msgData.modelID
            : undefined,
          usage: msgData.tokens
            ? {
                input_tokens: msgData.tokens.input ?? 0,
                output_tokens: msgData.tokens.output ?? 0,
                cache_read_input_tokens: msgData.tokens.cache?.read,
                cache_creation_input_tokens: msgData.tokens.cache?.write,
              }
            : undefined,
        });
      } else {
        const text = blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        messages.push({
          uuid: row.id,
          type: "user",
          timestamp: new Date(row.time_created).toISOString(),
          content: text,
        });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * First user message text for a session, if any (from the `part` table's text parts).
 * First prompts are immutable, so a FOUND prompt is cached per session id — the
 * process detector resolves them on every cache refresh. "Not found yet" is NOT
 * cached (the message lands milliseconds after the session row appears; caching
 * that null would poison the prompt match forever).
 * A missing/unreadable DB is NOT cached: the file may appear later.
 */
const firstUserMessageCache = new Map<string, string>();
const FIRST_USER_MESSAGE_CACHE_MAX = 1000;

export function getOpencodeFirstUserMessage(sessionId: string): string | null {
  const cached = firstUserMessageCache.get(sessionId);
  if (cached !== undefined) return cached;
  const db = findDbWithSession(sessionId) ?? getOpencodeDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT p.data FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user'
         ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC
         LIMIT 10`
      )
      .all(sessionId) as { data: string }[];
    for (const row of rows) {
      const text = parsePartText(row.data);
      if (text) {
        if (firstUserMessageCache.size >= FIRST_USER_MESSAGE_CACHE_MAX) {
          const oldest = firstUserMessageCache.keys().next().value;
          if (oldest) firstUserMessageCache.delete(oldest);
        }
        firstUserMessageCache.set(sessionId, text);
        return text;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function readOpencodeMessagesPaginated(
  sessionId: string,
  opts: { pageSize: number; before?: number }
): { messages: ParsedMessage[]; total: number; start: number } {
  const all = readOpencodeMessages(sessionId);
  const total = all.length;
  const end = opts.before == null ? total : Math.max(0, Math.min(total, opts.before));
  const start = Math.max(0, end - Math.max(1, opts.pageSize));
  return { messages: all.slice(start, end), total, start };
}
