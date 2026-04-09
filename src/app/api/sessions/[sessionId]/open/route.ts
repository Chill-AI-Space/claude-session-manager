import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { openInTerminal } from "@/lib/terminal-launcher";
import { getClaudePath } from "@/lib/claude-bin";
import { getForgePath } from "@/lib/forge-bin";
import { getCodexPath } from "@/lib/codex-bin";

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
  
  const agentType = (session as typeof session & { agent_type?: string }).agent_type ?? "claude";
  const isForge = agentType === "forge";
  const isCodex = agentType === "codex";

  let shellCmd: string;
  if (isCodex) {
    const bin = getCodexPath();
    const codexSkipFlag = skipPermissions ? " --dangerously-bypass-approvals-and-sandbox" : "";
    shellCmd = `cd "${cwd}" && "${bin}"${codexSkipFlag} resume "${sessionId}"`;
  } else if (isForge) {
    const bin = getForgePath();
    const model = (session as typeof session & { model?: string | null }).model || null;
    const forgeModelCmd = model ? `"${bin}" config set model "${model}" && ` : "";
    shellCmd = `cd "${cwd}" && ${forgeModelCmd}"${bin}" --conversation-id "${sessionId}"`;
  } else {
    const bin = getClaudePath();
    const model = getSetting("claude_model");
    const modelFlag = model ? ` --model "${model}"` : "";
    shellCmd = `cd "${cwd}" && "${bin}" --resume "${sessionId}"${skipFlag}${modelFlag}`;
  }

  try {
    const { terminal } = await openInTerminal(shellCmd);
    logAction("service", "open_in_terminal", terminal, sessionId);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
