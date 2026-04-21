import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getActiveSessionIds } from "@/lib/process-detector";
import type { SessionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/peers?path=/abs/path/to/repo
 *
 * Returns sessions in the same project_path as the given path.
 * Without `path` — returns all active sessions across all projects.
 * Used for inter-session coordination (sessions choreography).
 *
 * Query params:
 *   path        — (optional) absolute project_path to filter by
 *   exclude     — session_id to exclude (e.g. the caller itself)
 *   active_only — "false" to include inactive sessions (default: true)
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const path = searchParams.get("path");
  const exclude = searchParams.get("exclude");
  const activeOnly = searchParams.get("active_only") !== "false";

  const db = getDb();

  let activeIds: Set<string>;
  try {
    activeIds = getActiveSessionIds();
  } catch {
    activeIds = new Set();
  }

  const rows = path
    ? (db
        .prepare(
          `SELECT session_id, project_path, project_dir, generated_title, custom_name,
                  git_branch, model, SUBSTR(last_message, 1, 200) as last_message,
                  modified_at, created_at, message_count, last_message_role
           FROM sessions
           WHERE project_path = ? AND archived = 0
           ORDER BY modified_at DESC
           LIMIT 20`
        )
        .all(path) as SessionRow[])
    : (db
        .prepare(
          `SELECT session_id, project_path, project_dir, generated_title, custom_name,
                  git_branch, model, SUBSTR(last_message, 1, 200) as last_message,
                  modified_at, created_at, message_count, last_message_role
           FROM sessions
           WHERE archived = 0
           ORDER BY modified_at DESC
           LIMIT 50`
        )
        .all() as SessionRow[]);

  const peers = rows
    .map((row) => ({
      session_id: row.session_id,
      project_path: row.project_path,
      display_name:
        row.generated_title ||
        row.custom_name ||
        row.project_path.split(/[\\/]/).pop() ||
        row.project_dir,
      git_branch: row.git_branch,
      model: row.model,
      last_message: row.last_message,
      modified_at: row.modified_at,
      message_count: row.message_count,
      last_message_role: row.last_message_role,
      is_active: activeIds.has(row.session_id),
    }))
    .filter(
      (s) =>
        (!exclude || s.session_id !== exclude) &&
        (!activeOnly || s.is_active)
    );

  return NextResponse.json({ peers, total: peers.length });
}
