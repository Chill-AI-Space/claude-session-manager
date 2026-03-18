import fs from "fs";
import { getDb } from "@/lib/db";
import { detectActiveClaudeSessions } from "@/lib/process-detector";
import { getSessionMessageCount } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

interface SessionDiag {
  session_id: string;
  project: string;
  pid: number | null;
  process_detected: boolean;
  jsonl_messages: number;
  db_messages: number;
  drift: number;
  file_age_seconds: number;
  is_active_reported: boolean;
  stale_override: boolean;
  last_message_role: string | null;
  issues: string[];
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

export async function GET() {
  const db = getDb();
  const activeProcesses = detectActiveClaudeSessions();
  const activeMap = new Map(
    activeProcesses
      .filter((p) => p.sessionId)
      .map((p) => [p.sessionId!, p])
  );

  // Get all sessions that are either active OR recently modified (last 30 min)
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recentSessions = db
    .prepare(
      `SELECT session_id, jsonl_path, project_path, message_count,
              last_message_role, file_mtime, has_result
       FROM sessions
       WHERE modified_at > ? OR session_id IN (${
         activeProcesses
           .filter((p) => p.sessionId)
           .map(() => "?")
           .join(",") || "''"
       })
       ORDER BY modified_at DESC`
    )
    .all(
      cutoff,
      ...activeProcesses.filter((p) => p.sessionId).map((p) => p.sessionId!)
    ) as Array<
    Pick<
      SessionRow,
      | "session_id"
      | "jsonl_path"
      | "project_path"
      | "message_count"
      | "last_message_role"
      | "file_mtime"
    > & { has_result: number }
  >;

  const results: SessionDiag[] = [];

  for (const session of recentSessions) {
    const proc = activeMap.get(session.session_id);
    const processDetected = !!proc;

    let jsonlMessages = 0;
    let fileAgeMs = Infinity;
    try {
      jsonlMessages = getSessionMessageCount(session.jsonl_path);
      const mtime = fs.statSync(session.jsonl_path).mtimeMs;
      fileAgeMs = Date.now() - mtime;
    } catch {
      // file missing
    }

    const staleOverride =
      processDetected && fileAgeMs > STALE_THRESHOLD_MS;
    const isActiveReported = processDetected && !staleOverride;

    const drift = jsonlMessages - (session.message_count ?? 0);

    const issues: string[] = [];
    if (drift > 2) {
      issues.push(
        `DB behind JSONL by ${drift} messages (scanner needs to run)`
      );
    }
    if (processDetected && !isActiveReported) {
      issues.push(
        `Process running but marked inactive (stale threshold: file age ${Math.round(fileAgeMs / 60000)}min)`
      );
    }
    if (
      processDetected &&
      fileAgeMs > 5 * 60 * 1000 &&
      session.last_message_role !== "assistant"
    ) {
      issues.push(
        `Active process but JSONL not updated in ${Math.round(fileAgeMs / 60000)}min — possible write issue`
      );
    }
    if (!processDetected && !session.has_result && session.last_message_role === "assistant") {
      issues.push("Session ended without result event (crash or kill)");
    }

    results.push({
      session_id: session.session_id,
      project: session.project_path?.split("/").pop() || "unknown",
      pid: proc?.pid ?? null,
      process_detected: processDetected,
      jsonl_messages: jsonlMessages,
      db_messages: session.message_count ?? 0,
      drift,
      file_age_seconds: fileAgeMs === Infinity ? -1 : Math.round(fileAgeMs / 1000),
      is_active_reported: isActiveReported,
      stale_override: staleOverride,
      last_message_role: session.last_message_role ?? null,
      issues,
    });
  }

  // Summary
  const totalIssues = results.reduce((n, r) => n + r.issues.length, 0);
  const activeSessions = results.filter((r) => r.process_detected).length;
  const driftSessions = results.filter((r) => r.drift > 2).length;

  return Response.json({
    timestamp: new Date().toISOString(),
    summary: {
      active_sessions: activeSessions,
      recent_sessions: results.length,
      total_issues: totalIssues,
      sessions_with_drift: driftSessions,
    },
    sessions: results,
  });
}
