import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { openInTerminal } from "@/lib/terminal-launcher";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";

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
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  
  const isForge = session.agent_type === "forge";
  const bin = isForge ? getForgePath() : getClaudePath();
  const flag = isForge ? "--conversation-id" : "--resume";
  // For Claude: use claude_model setting. For Forge: use the model stored in the session
  // (do NOT use claude_model for Forge — it would overwrite Forge's Gemini config).
  const model = isForge
    ? (session as typeof session & { model?: string | null }).model || null
    : getSetting("claude_model");
  const modelFlag = !isForge && model ? ` --model "${model}"` : "";
  const forgeModelCmd = isForge && model ? `"${bin}" config set model "${model}" && ` : "";
  const shellCmd = `cd "${cwd}" && ${forgeModelCmd}"${bin}" ${flag} "${sessionId}"${isForge ? "" : skipFlag + modelFlag}`;

  try {
    const { terminal } = await openInTerminal(shellCmd);
    logAction("service", "open_in_terminal", terminal, sessionId);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
