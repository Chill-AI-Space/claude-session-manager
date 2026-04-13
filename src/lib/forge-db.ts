/**
 * Read-only accessor for Forge's SQLite database at ~/forge/.forge.db.
 * Never writes to Forge's DB. Returns empty results if DB is missing.
 */
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import type { ParsedMessage } from "./types";

const FORGE_DB_PATH = path.join(os.homedir(), "forge", ".forge.db");

let _forgeDb: Database.Database | null = null;

function getForgeDb(): Database.Database | null {
  if (_forgeDb) return _forgeDb;
  try {
    if (!fs.existsSync(FORGE_DB_PATH)) return null;
    _forgeDb = new Database(FORGE_DB_PATH, { readonly: true });
    return _forgeDb;
  } catch {
    return null;
  }
}

export interface ForgeConversationRow {
  conversation_id: string;
  title: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string | null;
  context: string | null;
  metrics: string | null;
}

export interface ForgeConversationMeta {
  conversation_id: string;
  title: string | null;
  cwd: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  first_prompt: string | null;
  last_message: string | null;
  last_message_role: "user" | "assistant" | null;
  message_count: number;
  model: string | null;
}

/** Parse an SQLite timestamp string ("2026-04-02 04:50:23.141517") to epoch ms */
function parseTimestampMs(ts: string | null): number {
  if (!ts) return 0;
  try {
    // Replace space with T and ensure Z suffix for UTC parsing
    return new Date(ts.replace(" ", "T") + (ts.includes("+") || ts.endsWith("Z") ? "" : "Z")).getTime();
  } catch {
    return 0;
  }
}

/** Extract cwd from System message content in Forge context JSON */
function extractCwdFromContext(context: string | null): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context) as { messages?: Array<{ message?: { text?: { role?: string; content?: string } } }> };
    for (const m of parsed.messages ?? []) {
      const content = m?.message?.text?.content;
      if (typeof content === "string" && m?.message?.text?.role === "System") {
        const match = content.match(/<current_working_directory>([^<]+)<\/current_working_directory>/);
        if (match) return match[1].trim();
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Get model from ~/.forge/.forge.toml */
function getForgeModel(): string {
  try {
    const tomlPath = path.join(os.homedir(), "forge", ".forge.toml");
    const content = fs.readFileSync(tomlPath, "utf-8");
    const match = content.match(/model_id\s*=\s*"([^"]+)"/);
    return match ? match[1] : "forge";
  } catch {
    return "forge";
  }
}

export function getCachedForgeModel(): string {
  return getForgeModel();
}

/** Extract user messages from Forge context JSON (for metadata) */
function extractUserMessages(context: string | null): string[] {
  if (!context) return [];
  try {
    const parsed = JSON.parse(context) as { messages?: Array<{ message?: { text?: { role?: string; content?: string; raw_content?: { Text?: string } } } }> };
    const results: string[] = [];
    for (const m of parsed.messages ?? []) {
      const role = m?.message?.text?.role;
      if (role !== "User") continue;
      // Prefer raw_content.Text (actual user text without XML wrappers)
      const raw = m?.message?.text?.raw_content?.Text;
      const content = m?.message?.text?.content ?? "";
      const text = raw || content.replace(/<task>|<\/task>|<system_date>[^<]*<\/system_date>/g, "").trim();
      if (text) results.push(text);
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * List all Forge conversations with lightweight metadata (no full context parse for most).
 * For incremental scan efficiency, we only parse context when conversation is new/changed.
 */
export function listForgeConversations(): ForgeConversationRow[] {
  const db = getForgeDb();
  if (!db) return [];
  try {
    return db
      .prepare("SELECT conversation_id, title, workspace_id, created_at, updated_at, context, metrics FROM conversations ORDER BY created_at DESC")
      .all() as ForgeConversationRow[];
  } catch {
    return [];
  }
}

/** Get a single conversation row */
export function getForgeConversation(conversationId: string): ForgeConversationRow | null {
  const db = getForgeDb();
  if (!db) return null;
  try {
    return (db
      .prepare("SELECT conversation_id, title, workspace_id, created_at, updated_at, context, metrics FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as ForgeConversationRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Extract full conversation metadata from a row (parses context JSON) */
export function extractForgeMeta(row: ForgeConversationRow): ForgeConversationMeta {
  const userMessages = extractUserMessages(row.context);
  const cwd = extractCwdFromContext(row.context);

  // Determine last message role from context
  let lastRole: "user" | "assistant" | null = null;
  try {
    const parsed = JSON.parse(row.context ?? "{}") as { messages?: Array<{ message?: { text?: { role?: string } } }> };
    const msgs = parsed.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const role = msgs[i]?.message?.text?.role;
      if (role === "User") { lastRole = "user"; break; }
      if (role === "Assistant") { lastRole = "assistant"; break; }
    }
  } catch { /* ignore */ }

  // Count non-system messages
  let msgCount = 0;
  try {
    const parsed = JSON.parse(row.context ?? "{}") as { messages?: Array<{ message?: { text?: { role?: string } } }> };
    msgCount = (parsed.messages ?? []).filter(m => {
      const r = m?.message?.text?.role;
      return r === "User" || r === "Assistant";
    }).length;
  } catch { /* ignore */ }

  return {
    conversation_id: row.conversation_id,
    title: row.title ?? null,
    cwd,
    created_at_ms: parseTimestampMs(row.created_at),
    updated_at_ms: parseTimestampMs(row.updated_at ?? row.created_at),
    first_prompt: userMessages[0]?.slice(0, 1000) ?? null,
    last_message: userMessages[userMessages.length - 1]?.slice(-1000) ?? null,
    last_message_role: lastRole,
    message_count: msgCount,
    model: getCachedForgeModel(),
  };
}

/**
 * Read full conversation messages as ParsedMessage[] for the session detail view.
 * Skips System messages, maps User→"user" and Assistant→"assistant".
 */
export function readForgeMessages(conversationId: string): ParsedMessage[] {
  const row = getForgeConversation(conversationId);
  if (!row?.context) return [];

  try {
    const parsed = JSON.parse(row.context) as {
      messages?: Array<{
        message?: {
          text?: {
            role?: string;
            content?: string;
            raw_content?: { Text?: string };
            tool_calls?: Array<{ name: string; call_id?: string; arguments?: unknown }>;
          };
          tool?: {
            name?: string;
            call_id?: string;
            output?: { is_error?: boolean; values?: Array<{ text?: string }> };
          };
        };
      }>;
    };

    const messages: ParsedMessage[] = [];
    let idx = 0;

    for (const m of parsed.messages ?? []) {
      const role = m?.message?.text?.role;

      // Tool result messages (undefined role, has m.message.tool)
      if (!role && m?.message?.tool) {
        const tool = m.message.tool;
        const toolOutput = tool.output?.values?.[0]?.text ?? "";
        const isError = tool.output?.is_error ?? false;
        const toolName = (tool.name ?? "tool").replace(/^mcp_playwright_tool_/, "");
        // Skip huge page snapshots (browser DOM dumps), show everything else
        const isHugeSnapshot = toolOutput.length > 3000 && (
          toolName.includes("snapshot") || toolName.includes("browser_")
        );
        if (!isHugeSnapshot && toolOutput) {
          const prefix = isError ? `❌ ${toolName}` : `✅ ${toolName}`;
          const preview = toolOutput.slice(0, 500);
          const suffix = toolOutput.length > 500 ? `\n…(${toolOutput.length} chars)` : "";
          messages.push({
            uuid: `forge-${conversationId}-${idx++}`,
            type: "assistant",
            timestamp: row.updated_at ?? row.created_at,
            content: [{ type: "text", text: `${prefix}: ${preview}${suffix}` }],
          });
        }
        continue;
      }

      if (role === "System") continue;

      const raw = m?.message?.text?.raw_content?.Text;
      const content = m?.message?.text?.content ?? "";
      const toolCalls = m?.message?.text?.tool_calls;
      const text = raw || content
        .replace(/<task>|<\/task>|<system_date>[^<]*<\/system_date>/g, "")
        .trim();

      if (role === "User") {
        messages.push({
          uuid: `forge-${conversationId}-${idx++}`,
          type: "user",
          timestamp: row.created_at,
          content: text || "(empty)",
        });
      } else if (role === "Assistant") {
        if (text) {
          messages.push({
            uuid: `forge-${conversationId}-${idx++}`,
            type: "assistant",
            timestamp: row.updated_at ?? row.created_at,
            content: [{ type: "text", text }],
          });
        } else if (toolCalls?.length) {
          // Assistant made tool calls without text — show with key argument
          const lines = toolCalls.map(t => {
            const name = t.name.replace(/^mcp_playwright_tool_/, "");
            const a = typeof t.arguments === "object" && t.arguments !== null
              ? t.arguments as Record<string, unknown>
              : {};
            let detail = "";
            if (name === "shell" || name === "run_command") {
              detail = String(a.command ?? a.cmd ?? "").slice(0, 120);
            } else if (name === "write" || name === "create_file") {
              detail = String(a.path ?? a.file_path ?? "");
            } else if (name === "patch" || name === "edit" || name === "str_replace") {
              detail = String(a.path ?? a.file_path ?? "");
            } else if (name === "read" || name === "read_file") {
              detail = String(a.path ?? a.file_path ?? "");
            } else if (name === "search" || name === "grep") {
              detail = String(a.pattern ?? a.query ?? a.search ?? "").slice(0, 80);
            } else {
              // Generic: show first string argument value
              const firstVal = Object.values(a).find(v => typeof v === "string");
              detail = firstVal ? String(firstVal).slice(0, 80) : "";
            }
            const label = name.replace(/_/g, " ");
            return detail ? `🔧 ${label}: ${detail}` : `🔧 ${label}`;
          });
          messages.push({
            uuid: `forge-${conversationId}-${idx++}`,
            type: "assistant",
            timestamp: row.updated_at ?? row.created_at,
            content: [{ type: "text", text: lines.join("\n") }],
          });
        }
      }
    }

    return messages;
  } catch {
    return [];
  }
}
