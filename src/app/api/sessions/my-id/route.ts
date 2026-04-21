import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getActiveSessionIds } from "@/lib/process-detector";
import type { SessionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/my-id?path=/abs/path/to/repo
 *
 * Returns the session_id for the currently-running session in the given
 * working directory. Intended for coordinators that need to verify their
 * own session_id before setting an alarm or delegating.
 *
 * Logic:
 *   1. Find all sessions whose project_path matches `path`
 *   2. Filter to those that are currently active (live process)
 *   3. If exactly one → return it
 *   4. If multiple → return the most-recently-started one (most likely "me")
 *      plus a `candidates` list so the caller can verify
 *   5. If none → return null (session not yet tracked or process undetectable)
 *
 * Response:
 *   { session_id: string | null, ok: boolean, candidates?: string[] }
 */
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path param required" }, { status: 400 });
  }

  const db = getDb();

  let activeIds: Set<string>;
  try {
    activeIds = getActiveSessionIds();
  } catch {
    activeIds = new Set();
  }

  const rows = db
    .prepare(
      `SELECT session_id, created_at, modified_at
       FROM sessions
       WHERE project_path = ? AND archived = 0
       ORDER BY created_at DESC
       LIMIT 20`
    )
    .all(path) as Pick<SessionRow, "session_id" | "created_at" | "modified_at">[];

  const active = rows.filter((r) => activeIds.has(r.session_id));

  if (active.length === 0) {
    // Fall back to most-recently-modified session in this path (process may not be detectable)
    if (rows.length === 0) {
      return NextResponse.json({ session_id: null, ok: false, reason: "no sessions found for path" });
    }
    return NextResponse.json({
      session_id: rows[0].session_id,
      ok: true,
      candidates: rows.slice(0, 3).map((r) => r.session_id),
      note: "process not detected — returning most-recently-modified session",
    });
  }

  if (active.length === 1) {
    return NextResponse.json({ session_id: active[0].session_id, ok: true });
  }

  // Multiple active sessions — return newest (most likely the coordinator, not a short-lived worker)
  return NextResponse.json({
    session_id: active[0].session_id,
    ok: true,
    candidates: active.map((r) => r.session_id),
    note: "multiple active sessions — returning most recently started; verify against your [Session Manager Context] block",
  });
}
