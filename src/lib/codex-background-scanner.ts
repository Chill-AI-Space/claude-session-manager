/**
 * Background periodic scanner for Codex sessions.
 * Runs scanCodexSessions every SCAN_INTERVAL_MS so Codex sessions appear
 * in the session list while they're actively running in a terminal.
 *
 * Uses globalThis singleton to survive Next.js hot reload.
 */
import { getDb } from "./db";
import { scanCodexSessions } from "./codex-scanner";
import * as dlog from "./debug-logger";

const SCAN_INTERVAL_MS = 30 * 1000; // 30 seconds

interface ScannerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
}

type GlobalWithScanner = typeof globalThis & {
  __codexBgScanner?: ScannerState;
};

async function doScan() {
  try {
    const db = getDb();

    const existingRows = db
      .prepare("SELECT session_id, file_mtime FROM sessions WHERE agent_type = 'codex'")
      .all() as { session_id: string; file_mtime: number }[];
    const existingMtimes = new Map(existingRows.map((r) => [r.session_id, r.file_mtime]));

    const upsertSession = db.prepare(`
      INSERT INTO sessions (
        session_id, jsonl_path, project_dir, project_path,
        git_branch, claude_version, model, first_prompt, last_message, last_message_role,
        has_result, message_count, total_input_tokens, total_output_tokens,
        created_at, modified_at, file_mtime, file_size, last_scanned_at
      ) VALUES (
        @session_id, @jsonl_path, @project_dir, @project_path,
        @git_branch, @claude_version, @model, @first_prompt, @last_message, @last_message_role,
        @has_result, @message_count, @total_input_tokens, @total_output_tokens,
        @created_at, @modified_at, @file_mtime, @file_size, @last_scanned_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        jsonl_path = @jsonl_path,
        project_dir = @project_dir,
        project_path = @project_path,
        model = COALESCE(@model, sessions.model),
        first_prompt = COALESCE(@first_prompt, sessions.first_prompt),
        last_message = COALESCE(@last_message, sessions.last_message),
        has_result = @has_result,
        total_input_tokens = @total_input_tokens,
        modified_at = @modified_at,
        file_mtime = @file_mtime,
        last_scanned_at = @last_scanned_at
    `);

    const { scanned } = await scanCodexSessions(db, existingMtimes, "incremental", upsertSession);
    if (scanned > 0) {
      dlog.info("codex-bg-scanner", `indexed ${scanned} new/updated Codex sessions`);
    }
  } catch (err) {
    dlog.info("codex-bg-scanner", `scan error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Start the background Codex scanner if not already running.
 * Safe to call on every request — idempotent.
 */
export function ensureCodexBackgroundScanner() {
  const g = globalThis as GlobalWithScanner;
  if (g.__codexBgScanner?.started) return;

  const state: ScannerState = { started: true, timer: null };
  g.__codexBgScanner = state;

  // Run once immediately (async, fire-and-forget)
  doScan().catch(() => {});

  // Then on interval — unref so it doesn't block process exit
  state.timer = setInterval(() => {
    doScan().catch(() => {});
  }, SCAN_INTERVAL_MS);

  if (state.timer.unref) state.timer.unref();
}
