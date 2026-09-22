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
import type { ContentBlock, ParsedMessage } from "./types";

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

/** Single session row by id, or null if the DB is missing or the id doesn't exist. */
export function getOpencodeSession(sessionId: string): OpencodeSessionRow | null {
  const db = getOpencodeDb();
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
  const db = getOpencodeDb();
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
