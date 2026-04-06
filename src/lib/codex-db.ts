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
  payload?: Record<string, unknown>;
}

/** Map Codex tool names + args to the format ToolUseBlock expects */
function normalizeCodexTool(
  name: string,
  argsStr: string
): { name: string; input: Record<string, unknown> } {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(argsStr) as Record<string, unknown>;
  } catch { /* ignore */ }

  // Strip internal/noisy fields that clutter the UI
  const {
    justification: _j,
    prefix_rule: _pr,
    sandbox_permissions: _sp,
    yield_time_ms: _yt,
    max_output_tokens: _mo,
    ...input
  } = raw;

  switch (name) {
    case "exec_command": {
      const { cmd, ...rest } = input;
      return { name: "Bash", input: { command: cmd, ...rest } };
    }
    case "read_file": {
      const { path, ...rest } = input;
      return { name: "Read", input: { file_path: path, ...rest } };
    }
    case "write_file": {
      const { path, ...rest } = input;
      return { name: "Write", input: { file_path: path, ...rest } };
    }
    case "patch_file": {
      const { path, ...rest } = input;
      return { name: "Edit", input: { file_path: path, ...rest } };
    }
    case "find_files":
      return { name: "Glob", input };
    case "search_text": {
      const { pattern, query, ...rest } = input;
      return { name: "Grep", input: { pattern: pattern ?? query, ...rest } };
    }
    case "web_search":
      return { name: "WebSearch", input };
    case "web_fetch":
      return { name: "WebFetch", input };
    case "write_stdin": {
      const { text, ...rest } = input;
      return { name: "write_stdin", input: { input: text, ...rest } };
    }
    case "list_mcp_resources":
    case "read_mcp_resource":
      return { name, input };
    default:
      return { name, input };
  }
}

/** Trim function_call_output to a reasonable display size */
function trimToolOutput(output: string): string {
  const MAX = 3000;
  if (output.length <= MAX) return output;
  return output.slice(0, MAX) + `\n…(${output.length} chars total)`;
}

interface Turn {
  timestamp: string;
  textBlocks: string[];
  /** tool_use + matching tool_result blocks interleaved */
  toolBlocks: import("./types").ContentBlock[];
  /** call_id → index in toolBlocks for pairing outputs */
  callIndex: Map<string, number>;
}

/** Read Codex session messages from the rollout JSONL file.
 *
 * Groups by turn (task_started → task_complete):
 *  - user_message  → right-aligned user bubble
 *  - agent_message → text block in assistant bubble
 *  - function_call → tool_use block (with ToolUseBlock rendering)
 *  - function_call_output → tool_result block paired by call_id
 */
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
  let turn: Turn | null = null;

  function emitTurn() {
    if (!turn) return;
    const hasText = turn.textBlocks.some(t => t.trim());
    const hasTools = turn.toolBlocks.length > 0;
    if (!hasText && !hasTools) { turn = null; return; }

    const content: import("./types").ContentBlock[] = [];
    // Text first, then tools (mirrors Claude rendering order)
    for (const t of turn.textBlocks) {
      if (t.trim()) content.push({ type: "text", text: t });
    }
    for (const b of turn.toolBlocks) {
      content.push(b);
    }
    messages.push({
      uuid: `codex-${idx++}`,
      type: "assistant",
      timestamp: turn.timestamp,
      content,
    });
    turn = null;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d: CodexJsonlLine;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = (d.timestamp as string | undefined) ?? new Date().toISOString();
    const type = d.type;
    const p = (d.payload ?? {}) as Record<string, unknown>;
    const pt = p.type as string | undefined;

    if (type === "event_msg") {
      if (pt === "user_message") {
        const msg = p.message as string | undefined;
        if (!msg) continue;
        emitTurn();
        messages.push({
          uuid: `codex-${idx++}`,
          type: "user",
          timestamp: ts,
          content: msg,
        });
      } else if (pt === "task_started") {
        // Begin accumulating a new agent turn
        emitTurn();
        turn = { timestamp: ts, textBlocks: [], toolBlocks: [], callIndex: new Map() };
      } else if (pt === "agent_message") {
        const msg = p.message as string | undefined;
        if (!msg || !turn) continue;
        // Deduplicate: skip if this text already added in turn
        if (!turn.textBlocks.includes(msg)) {
          turn.textBlocks.push(msg);
        }
      } else if (pt === "task_complete") {
        emitTurn();
      }
    } else if (type === "response_item") {
      if (pt === "function_call") {
        if (!turn) turn = { timestamp: ts, textBlocks: [], toolBlocks: [], callIndex: new Map() };
        const name = p.name as string | undefined;
        const argsStr = (p.arguments as string | undefined) ?? "{}";
        const callId = (p.call_id as string | undefined) ?? `call-${idx}`;
        if (!name) continue;
        const { name: normName, input } = normalizeCodexTool(name, argsStr);
        const toolUseIdx = turn.toolBlocks.length;
        turn.callIndex.set(callId, toolUseIdx);
        turn.toolBlocks.push({ type: "tool_use", id: callId, name: normName, input });
      } else if (pt === "function_call_output") {
        if (!turn) continue;
        const callId = p.call_id as string | undefined;
        const output = trimToolOutput((p.output as string | undefined) ?? "");
        // Append a tool_result block — MessageBubble matches it by tool_use_id
        turn.toolBlocks.push({
          type: "tool_result",
          tool_use_id: callId ?? "",
          content: output,
        });
      } else if (pt === "custom_tool_call") {
        // MCP tool calls
        if (!turn) turn = { timestamp: ts, textBlocks: [], toolBlocks: [], callIndex: new Map() };
        const name = (p.name as string | undefined) ?? "mcp_tool";
        const input = (p.input ?? {}) as Record<string, unknown>;
        const callId = (p.call_id as string | undefined) ?? `mcp-${idx}`;
        turn.callIndex.set(callId, turn.toolBlocks.length);
        turn.toolBlocks.push({ type: "tool_use", id: callId, name, input });
      } else if (pt === "custom_tool_call_output") {
        if (!turn) continue;
        const callId = p.call_id as string | undefined;
        const output = trimToolOutput(
          typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")
        );
        turn.toolBlocks.push({
          type: "tool_result",
          tool_use_id: callId ?? "",
          content: output,
        });
      }
    }
  }

  // Flush any open turn (session still in progress)
  emitTurn();

  return messages;
}
