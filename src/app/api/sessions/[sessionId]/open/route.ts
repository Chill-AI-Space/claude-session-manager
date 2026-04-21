import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import { getClaudePath } from "@/lib/claude-bin";
import { getCodexPath } from "@/lib/codex-bin";
import { buildCodexOpenArgs } from "@/lib/codex-command";
import { buildResumeShellCommand } from "@/lib/session-terminal";
import { openInTerminal, WindowsTerminalPref } from "@/lib/terminal-launcher";
import { SessionRow } from "@/lib/types";

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
  const cwd = session.project_path;
  const isWin = process.platform === "win32";
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const preferredTerminal = (getSetting("preferred_terminal") || "auto") as WindowsTerminalPref;
  const agentType = (session as SessionRow & { agent_type?: string }).agent_type ?? "claude";

  let windowsLaunch:
    | { executable: string; args: string[]; preferredTerminal: WindowsTerminalPref }
    | undefined;

  if (isWin && agentType === "claude") {
    const args = ["--resume", sessionId];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    windowsLaunch = {
      executable: getClaudePath(),
      args,
      preferredTerminal,
    };
  } else if (isWin && agentType === "codex") {
    windowsLaunch = {
      executable: getCodexPath(),
      args: buildCodexOpenArgs({ sessionId, skipPermissions }),
      preferredTerminal,
    };
  }

  try {
    const { terminal } = await openInTerminal(shellCmd, cwd, windowsLaunch);
    logAction("service", "open_in_terminal", terminal, sessionId);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
