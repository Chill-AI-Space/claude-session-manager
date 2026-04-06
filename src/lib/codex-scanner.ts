/**
 * Scanner for Codex AI agent sessions.
 * Reads from ~/.codex/state_5.sqlite and upserts into the sessions table
 * with agent_type='codex' and jsonl_path=rollout_path (actual JSONL file).
 */
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { logAction } from "./db";
import { listCodexThreads } from "./codex-db";
import * as dlog from "./debug-logger";

/** Convert a filesystem path to a project_dir key (same convention as Claude) */
function toProjectDir(p: string): string {
  return p.replace(/[\\/]/g, "-");
}

export async function scanCodexSessions(
  db: Database.Database,
  existingMtimes: Map<string, number>,
  mode: "full" | "incremental",
  upsertSession: Database.Statement
): Promise<{ scanned: number; skipped: number }> {
  const threads = listCodexThreads();
  if (threads.length === 0) return { scanned: 0, skipped: 0 };

  let scanned = 0;
  let skipped = 0;

  const insertBatch = db.transaction(() => {
    for (const thread of threads) {
      const threadId = thread.id;
      const rolloutPath = thread.rollout_path;

      // Skip if JSONL file doesn't exist yet
      if (!rolloutPath || !fs.existsSync(rolloutPath)) {
        skipped++;
        continue;
      }

      // File mtime for incremental scan
      let fileMtime = thread.updated_at * 1000; // epoch ms
      try {
        const stat = fs.statSync(rolloutPath);
        fileMtime = stat.mtimeMs;
      } catch { /* use DB timestamp */ }

      // Incremental scan: skip if unchanged
      if (mode === "incremental" && existingMtimes.has(threadId)) {
        const existing = existingMtimes.get(threadId)!;
        if (Math.abs(existing - fileMtime) < 1000) {
          skipped++;
          continue;
        }
      }

      const cwd = thread.cwd ?? os.homedir();
      const projectDir = toProjectDir(cwd);
      const now = new Date().toISOString();

      // Determine model label
      const model = thread.model
        ? thread.model
        : thread.model_provider === "openai"
          ? "gpt-4o"
          : thread.model_provider;

      const firstPrompt = thread.first_user_message?.slice(0, 500) || null;
      const title = thread.title || null;

      upsertSession.run({
        session_id: threadId,
        jsonl_path: rolloutPath,
        project_dir: projectDir,
        project_path: cwd,
        git_branch: thread.git_branch ?? null,
        claude_version: null,
        model,
        first_prompt: firstPrompt,
        last_message: firstPrompt,
        last_message_role: null,
        has_result: 1,
        message_count: 0,
        total_input_tokens: thread.tokens_used ?? 0,
        total_output_tokens: 0,
        created_at: new Date(thread.created_at * 1000).toISOString(),
        modified_at: new Date(fileMtime).toISOString(),
        file_mtime: fileMtime,
        file_size: 0,
        last_scanned_at: now,
      });

      // Set agent_type and generated_title
      db.prepare(
        `UPDATE sessions SET agent_type = 'codex', model = ?${title ? ", generated_title = COALESCE(generated_title, ?)" : ""} WHERE session_id = ?`
      ).run(...(title ? [model, title, threadId] : [model, threadId]));

      scanned++;
    }
  });

  insertBatch();

  if (scanned > 0 || skipped > 0) {
    dlog.info("codex-scanner", `codex scan: ${scanned} scanned, ${skipped} skipped`);
  }

  return { scanned, skipped };
}
