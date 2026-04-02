/**
 * Scanner for Forge AI agent sessions.
 * Reads from ~/forge/.forge.db and upserts into the sessions table
 * with agent_type='forge' and jsonl_path='forge://{conversationId}'.
 */
import type Database from "better-sqlite3";
import os from "os";
import path from "path";
import { logAction } from "./db";
import { listForgeConversations, extractForgeMeta } from "./forge-db";
import { STALL_THRESHOLD_MS } from "./orchestrator";
import * as dlog from "./debug-logger";

/** Encode a Forge conversation ID as a sentinel path */
export function forgeConvPath(conversationId: string): string {
  return `forge://${conversationId}`;
}

/** Decode a sentinel path back to a conversation ID */
export function parseForgeConvPath(jsonlPath: string): string | null {
  if (jsonlPath.startsWith("forge://")) return jsonlPath.slice(8);
  return null;
}

/** Convert a filesystem path to a project_dir key (same convention as Claude) */
function toProjectDir(p: string): string {
  // Replace both / and \ with -, leading dash is intentional (matches Claude convention)
  return p.replace(/[\\/]/g, "-");
}

export async function scanForgeSessions(
  db: Database.Database,
  existingMtimes: Map<string, number>,
  mode: "full" | "incremental",
  upsertSession: Database.Statement
): Promise<{ scanned: number; skipped: number }> {
  const rows = listForgeConversations();
  if (rows.length === 0) return { scanned: 0, skipped: 0 };

  let scanned = 0;
  let skipped = 0;

  // Deferred babysitter actions to run outside DB transaction
  const postTxActions: Array<() => void> = [];

  const insertForgeBatch = db.transaction((items: typeof rows) => {
    for (const row of items) {
      const conversationId = row.conversation_id;

      // Skip empty sessions (no context yet)
      if (!row.context) {
        skipped++;
        continue;
      }

      const meta = extractForgeMeta(row);
      const fileMtime = meta.updated_at_ms || meta.created_at_ms;
      const jsonlPath = forgeConvPath(conversationId);

      // Incremental scan: skip if updated_at unchanged
      if (mode === "incremental" && existingMtimes.has(conversationId)) {
        const existing = existingMtimes.get(conversationId)!;
        if (Math.abs(existing - fileMtime) < 1000) {
          skipped++;
          continue;
        }
      }

      const cwd = meta.cwd ?? path.join(os.homedir());
      const projectDir = toProjectDir(cwd);
      const now = new Date().toISOString();

      // Check for stall: last message is 'user' (we sent a prompt but Forge hasn't replied)
      // and updated_at is older than STALL_THRESHOLD_MS
      if (meta.last_message_role === "user") {
        const silentMs = Date.now() - fileMtime;
        if (silentMs > STALL_THRESHOLD_MS) {
          const capturedId = conversationId;
          const capturedPath = cwd;
          postTxActions.push(() => {
            // Check orchestrator isn't already handling this
            try {
              const { getOrchestrator } = require("./orchestrator");
              const state = getOrchestrator().status(capturedId);
              if (state && !["idle", "completed", "failed"].includes(state.phase)) return;
              logAction("service", "forge_stall_detected", `silent:${Math.round(silentMs / 60_000)}min`, capturedId);
              getOrchestrator().resumeForgeBackground(capturedId, "continue", capturedPath);
            } catch { /* non-critical */ }
          });
        }
      }

      upsertSession.run({
        session_id: conversationId,
        jsonl_path: jsonlPath,
        project_dir: projectDir,
        project_path: cwd,
        git_branch: null,
        claude_version: null,
        model: meta.model,
        first_prompt: meta.first_prompt,
        last_message: meta.last_message,
        last_message_role: meta.last_message_role,
        has_result: meta.last_message_role === "assistant" ? 1 : 0,
        message_count: meta.message_count,
        total_input_tokens: 0,
        total_output_tokens: 0,
        created_at: new Date(meta.created_at_ms || Date.now()).toISOString(),
        modified_at: new Date(fileMtime || Date.now()).toISOString(),
        file_mtime: fileMtime,
        file_size: 0,
        last_scanned_at: now,
      });

      // Set agent_type to 'forge' and generated_title from Forge's title
      db.prepare(
        `UPDATE sessions SET agent_type = 'forge'${meta.title ? ", generated_title = COALESCE(generated_title, ?)" : ""} WHERE session_id = ?`
      ).run(...(meta.title ? [meta.title, conversationId] : [conversationId]));

      scanned++;
    }
  });

  insertForgeBatch(rows);

  for (const action of postTxActions) {
    action();
  }

  if (scanned > 0 || skipped > 0) {
    dlog.info("forge-scanner", `forge scan: ${scanned} scanned, ${skipped} skipped`);
  }

  return { scanned, skipped };
}
