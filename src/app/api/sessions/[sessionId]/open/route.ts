import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { openInTerminal, WindowsTerminalPref } from "@/lib/terminal-launcher";
import { getClaudePath } from "@/lib/claude-bin";

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

  const cwd = session.project_path;
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";

  // Build args for claude CLI
  const claudeArgs = ["--resume", sessionId];
  if (skipPermissions) claudeArgs.push("--dangerously-skip-permissions");

  // On Windows, pass executable + args directly to avoid OEM codepage
  // issues with non-ASCII paths in shell command strings
  const isWin = process.platform === "win32";
  const claudePath = getClaudePath();
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const shellCmd = `cd "${cwd}" && claude --resume "${sessionId}"${skipFlag}`;

  try {
    const { terminal } = await openInTerminal(
      shellCmd,
      cwd,
      isWin ? { executable: claudePath, args: claudeArgs, preferredTerminal: (getSetting("preferred_terminal") || "auto") as WindowsTerminalPref } : undefined
    );
    logAction("service", "open_in_terminal", terminal, sessionId);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
