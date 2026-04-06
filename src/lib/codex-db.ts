/**
 * Read-only accessor for Codex's SQLite database at ~/.codex/state_5.sqlite.
 * Never writes to Codex's DB. Returns empty results if DB is missing.
 */
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import type { ParsedMessage } from "./types";

const CODEX_DB_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");

let _codexDb: Database.Database | null = null;

function getCodexDb(): Database.Database | null {
  if (_codexDb) return _codexDb;
  try {
    if (!fs.existsSync(CODEX_DB_PATH)) return null;
    _codexDb = new Database(CODEX_DB_PATH, { readonly: true });
    return _codexDb;
  } catch {
    return null;
  }
}

export interface CodexThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
  model: string | null;
  model_provider: string;
  created_at: number; // epoch seconds
  updated_at: number; // epoch seconds
  first_user_message: string;
  git_branch: string | null;
  tokens_used: number;
}

export function listCodexThreads(): CodexThreadRow[] {
  const db = getCodexDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, rollout_path, cwd, title, model, model_provider,
                created_at, updated_at, first_user_message, git_branch, tokens_used
         FROM threads
         WHERE archived = 0
         ORDER BY updated_at DESC`
      )
      .all() as CodexThreadRow[];
  } catch {
    return [];
  }
}

export function getCodexThread(id: string): CodexThreadRow | null {
  const db = getCodexDb();
  if (!db) return null;
  try {
    return (
      db
        .prepare(
          `SELECT id, rollout_path, cwd, title, model, model_provider,
                  created_at, updated_at, first_user_message, git_branch, tokens_used
           FROM threads WHERE id = ?`
        )
        .get(id) as CodexThreadRow | undefined
    ) ?? null;
  } catch {
    return null;
  }
}

interface CodexJsonlLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: string;
    phase?: string;
    name?: string;
    arguments?: string;
    output?: string;
    cmd?: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
}

/** Read Codex session messages from the rollout JSONL file */
export function readCodexMessages(rolloutPath: string): ParsedMessage[] {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(rolloutPath, "utf-8");
  } catch {
    return [];
  }

  const messages: ParsedMessage[] = [];
  let idx = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d: CodexJsonlLine;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = d.timestamp ?? new Date().toISOString();
    const type = d.type;
    const p = d.payload ?? {};
    const pt = p.type;

    if (type === "event_msg") {
      if (pt === "user_message" && p.message) {
        messages.push({
          uuid: `codex-${idx++}`,
          type: "user",
          timestamp: ts,
          content: p.message,
        });
      } else if (pt === "agent_message" && p.message) {
        messages.push({
          uuid: `codex-${idx++}`,
          type: "assistant",
          timestamp: ts,
          content: [{ type: "text", text: p.message }],
        });
      }
    } else if (type === "response_item") {
      if (pt === "function_call" && p.name) {
        // Show tool call as a brief note
        let detail = "";
        try {
          if (p.arguments) {
            const args = JSON.parse(p.arguments) as Record<string, unknown>;
            const cmd = args.cmd ?? args.command ?? args.path ?? args.query ?? args.input;
            if (cmd) detail = `: ${String(cmd).slice(0, 100)}`;
          }
        } catch { /* ignore */ }
        const toolName = (p.name ?? "tool").replace(/_/g, " ");
        messages.push({
          uuid: `codex-${idx++}`,
          type: "assistant",
          timestamp: ts,
          content: [{ type: "text", text: `🔧 ${toolName}${detail}` }],
        });
      }
    }
  }

  return messages;
}
