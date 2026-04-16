import { NextRequest } from "next/server";
import { basename } from "path";
import { detectActiveClaudeSessions } from "@/lib/process-detector";
import { getDb, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { controlTerminalSession, getTTY } from "@/lib/macos-terminal-control";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  if (process.platform !== "darwin") {
    return Response.json({ error: "Close terminal is only supported on macOS" }, { status: 501 });
  }

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const processes = detectActiveClaudeSessions();
  const proc = processes.find((p) => p.sessionId === sessionId);
  const tty = proc ? getTTY(proc.pid) : null;

  const result = controlTerminalSession({
    action: "close",
    tty,
    sessionId,
    projectPath: session.project_path,
    projectName: basename(session.project_path),
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.reason === "not_found" ? 404 : 500 });
  }

  logAction(
    "service",
    result.match === "tty" ? "close_terminal" : "close_terminal_matched",
    tty ?? session.project_path,
    sessionId
  );
  return Response.json({ ok: true, match: result.match, tty });
}
