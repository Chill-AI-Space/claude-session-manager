import { NextRequest } from "next/server";
import { basename } from "path";
import { detectActiveClaudeSessions } from "@/lib/process-detector";
import { getDb, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { buildResumeShellCommand } from "@/lib/session-terminal";
import { openInTerminal } from "@/lib/terminal-launcher";
import { controlTerminalSession, getTTY } from "@/lib/macos-terminal-control";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const db = getDb();

  if (process.platform !== "darwin") {
    return Response.json({ error: "Focus terminal is only supported on macOS" }, { status: 501 });
  }

  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const processes = detectActiveClaudeSessions();
  const proc = processes.find((p) => p.sessionId === sessionId);
  const tty = proc ? getTTY(proc.pid) : null;
  const focusResult = controlTerminalSession({
    action: "focus",
    tty,
    sessionId,
    projectPath: session.project_path,
    projectName: basename(session.project_path),
  });

  if (focusResult.ok) {
    logAction(
      "service",
      focusResult.match === "tty" ? "focus_terminal" : "focus_terminal_matched",
      tty ?? session.project_path,
      sessionId
    );
    return Response.json({ ok: true, mode: "focused", match: focusResult.match, tty });
  }

  if (focusResult.reason === "applescript") {
    return Response.json({ error: focusResult.error }, { status: 500 });
  }

  if (!proc) {
    try {
      const shellCmd = buildResumeShellCommand(session);
      const { terminal } = await openInTerminal(shellCmd);
      logAction("service", "focus_terminal_reopen", terminal, sessionId);
      return Response.json({ ok: true, mode: "opened", terminal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return Response.json(
        { error: `No active terminal process found; failed to reopen session: ${msg}` },
        { status: 500 }
      );
    }
  }

  if (!tty) {
    return Response.json({ error: "Could not determine TTY — process may have exited" }, { status: 500 });
  }

  return Response.json({ error: focusResult.error, tty }, { status: 500 });
}
