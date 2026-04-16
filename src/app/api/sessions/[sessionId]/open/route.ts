import { NextRequest } from "next/server";
import { getDb, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { openInTerminal } from "@/lib/terminal-launcher";
import { buildResumeShellCommand } from "@/lib/session-terminal";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const shellCmd = buildResumeShellCommand(session);

  try {
    const { terminal } = await openInTerminal(shellCmd);
    logAction("service", "open_in_terminal", terminal, sessionId);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
