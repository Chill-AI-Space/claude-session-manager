/**
 * Read-only accessor for Codex's SQLite database at ~/.codex/state_5.sqlite.
 * Never writes to Codex's DB. Returns empty results if DB is missing.
 */
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import type { ParsedMessage } from "./types";
import { iterateLinesSync } from "./utils-server";

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

const MAX_FTS_TEXT = 20_000;

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
  const MAX = 12000;
  if (output.length <= MAX) return output;
  return output.slice(0, MAX) + `\n…(${output.length} chars total)`;
}

interface Turn {
  timestamp: string;
  /** All blocks in chronological order — text and tools interleaved as they appeared */
  blocks: import("./types").ContentBlock[];
  /** Tracks already-added text to avoid duplicates from parallel event streams */
  seenText: Set<string>;
}

/** Read Codex session messages from the rollout JSONL file.
 *
 * Groups by turn (task_started → task_complete):
 *  - user_message  → right-aligned user bubble
 *  - agent_message → text block, interleaved with tools in chronological order
 *  - function_call → tool_use block
 *  - function_call_output → tool_result block
 *
 * Blocks are kept in arrival order so the final summary text appears at the
 * bottom of the assistant bubble (after all tool calls), matching the terminal.
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
    const content = turn.blocks.filter(
      b => b.type !== "text" || (b as { type: "text"; text: string }).text.trim()
    );
    if (content.length === 0) { turn = null; return; }
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
        emitTurn();
        turn = { timestamp: ts, blocks: [], seenText: new Set() };
      } else if (pt === "agent_message") {
        const msg = p.message as string | undefined;
        if (!msg) continue;
        // Auto-create turn if user_message arrived without a new task_started
        if (!turn) turn = { timestamp: ts, blocks: [], seenText: new Set() };
        if (!turn.seenText.has(msg)) {
          turn.seenText.add(msg);
          turn.blocks.push({ type: "text", text: msg });
        }
      } else if (pt === "task_complete") {
        emitTurn();
      }
    } else if (type === "response_item") {
      if (pt === "function_call") {
        if (!turn) turn = { timestamp: ts, blocks: [], seenText: new Set() };
        const name = p.name as string | undefined;
        const argsStr = (p.arguments as string | undefined) ?? "{}";
        const callId = (p.call_id as string | undefined) ?? `call-${idx}`;
        if (!name) continue;
        const { name: normName, input } = normalizeCodexTool(name, argsStr);
        turn.blocks.push({ type: "tool_use", id: callId, name: normName, input });
      } else if (pt === "function_call_output") {
        if (!turn) continue;
        const callId = p.call_id as string | undefined;
        const output = trimToolOutput((p.output as string | undefined) ?? "");
        turn.blocks.push({ type: "tool_result", tool_use_id: callId ?? "", content: output });
      } else if (pt === "custom_tool_call") {
        if (!turn) turn = { timestamp: ts, blocks: [], seenText: new Set() };
        const name = (p.name as string | undefined) ?? "mcp_tool";
        const input = (p.input ?? {}) as Record<string, unknown>;
        const callId = (p.call_id as string | undefined) ?? `mcp-${idx}`;
        turn.blocks.push({ type: "tool_use", id: callId, name, input });
      } else if (pt === "custom_tool_call_output") {
        if (!turn) continue;
        const callId = p.call_id as string | undefined;
        const output = trimToolOutput(
          typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")
        );
        turn.blocks.push({ type: "tool_result", tool_use_id: callId ?? "", content: output });
      }
    }
  }

  // Flush any open turn (session still in progress)
  emitTurn();

  return messages;
}

/**
 * Returns true if the Codex JSONL rollout file ends with a task_complete event.
 * Used to reliably detect when Codex has finished its task (process may still linger).
 */
export function codexSessionCompleted(rolloutPath: string): boolean {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;
  try {
    const content = fs.readFileSync(rolloutPath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    // Scan last 10 lines for task_complete (it's usually one of the last events)
    for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev?.payload?.type === "task_complete") return true;
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return false;
}

export function extractCodexSearchText(rolloutPath: string): string {
  return extractCodexRolloutIndex(rolloutPath).searchText;
}

export interface CodexSessionSummary {
  messageCount: number;
  lastMessage: string;
  lastMessageRole: "user" | "assistant" | null;
}

export interface CodexRolloutIndex {
  hasResult: boolean;
  searchText: string;
  summary: CodexSessionSummary;
}

export function extractCodexRolloutIndex(rolloutPath: string): CodexRolloutIndex {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return {
      hasResult: false,
      searchText: "",
      summary: { messageCount: 0, lastMessage: "", lastMessageRole: null },
    };
  }

  const textParts: string[] = [];
  let textPartsSize = 0;
  let hasResult = false;
  let messageCount = 0;
  let lastMessage = "";
  let lastMessageRole: "user" | "assistant" | null = null;
  let turnOpen = false;
  let turnHasContent = false;
  let turnFirstText = "";
  let turnSeenText = new Set<string>();

  const appendSearchText = (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || textPartsSize >= MAX_FTS_TEXT) return;
    textParts.push(trimmed);
    textPartsSize += trimmed.length;
  };

  const resetTurn = () => {
    turnOpen = false;
    turnHasContent = false;
    turnFirstText = "";
    turnSeenText = new Set<string>();
  };

  const ensureTurn = () => {
    if (turnOpen) return;
    turnOpen = true;
    turnHasContent = false;
    turnFirstText = "";
    turnSeenText = new Set<string>();
  };

  const emitTurn = () => {
    if (!turnOpen) return;
    if (turnHasContent) {
      messageCount++;
      lastMessage = turnFirstText.trim();
      lastMessageRole = "assistant";
    }
    resetTurn();
  };

  try {
    for (const line of iterateLinesSync(rolloutPath)) {
      let d: CodexJsonlLine;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }

      const type = d.type;
      const p = (d.payload ?? {}) as Record<string, unknown>;
      const pt = p.type as string | undefined;

      if (type === "event_msg") {
        if (pt === "user_message") {
          emitTurn();
          const msg = typeof p.message === "string" ? p.message : "";
          if (!msg) continue;
          appendSearchText(msg);
          messageCount++;
          lastMessage = msg.trim();
          lastMessageRole = "user";
        } else if (pt === "task_started") {
          emitTurn();
          ensureTurn();
        } else if (pt === "agent_message") {
          const msg = typeof p.message === "string" ? p.message : "";
          if (!msg) continue;
          appendSearchText(msg);
          ensureTurn();
          if (!turnSeenText.has(msg)) {
            turnSeenText.add(msg);
            turnHasContent = true;
            if (!turnFirstText) turnFirstText = msg;
          }
        } else if (pt === "task_complete") {
          hasResult = true;
          emitTurn();
        }
      } else if (type === "response_item") {
        if (pt === "function_call" || pt === "custom_tool_call") {
          ensureTurn();
          turnHasContent = true;
        } else if (
          turnOpen &&
          (pt === "function_call_output" || pt === "custom_tool_call_output")
        ) {
          turnHasContent = true;
        }
      }
    }
  } catch {
    return {
      hasResult: false,
      searchText: "",
      summary: { messageCount: 0, lastMessage: "", lastMessageRole: null },
    };
  }

  emitTurn();

  return {
    hasResult,
    searchText: textParts.join("\n"),
    summary: { messageCount, lastMessage, lastMessageRole },
  };
}

export function extractCodexSessionSummary(rolloutPath: string): CodexSessionSummary {
  return extractCodexRolloutIndex(rolloutPath).summary;
}
