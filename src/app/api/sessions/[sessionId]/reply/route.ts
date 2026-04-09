import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import type { SessionRow } from "@/lib/types";
import { killSessionProcesses } from "@/lib/process-detector";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse, SSE_HEADERS } from "@/lib/claude-runner";
import { resolveNode, proxySSE } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();
  const message = body.message;
  const verbose = body.verbose === true;
  const delegatingSessionId: string | undefined = body.delegating_session_id;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  // Check if this is a remote session
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);

  if (node) {
    // Route to remote VM
    logAction("service", "remote_reply", `node:${node.name} msg_len:${message.length}`, sessionId);
    try {
      const stream = await proxySSE(node, `/api/sessions/${sessionId}/reply`, {
        message,
        verbose,
      });
      return new Response(stream, { headers: SSE_HEADERS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote reply failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  logAction("service", "reply", `msg_len:${message.length}`, sessionId);

  // Mark delegation as replied.
  // If the child passed delegating_session_id explicitly — use it directly.
  // Otherwise auto-detect: any pending child that points to this session as parent.
  try {
    if (delegatingSessionId) {
      db.prepare(
        "UPDATE sessions SET delegation_status = 'replied' WHERE session_id = ? AND delegation_status = 'pending'"
      ).run(delegatingSessionId);
    } else {
      // Auto-detect: mark the oldest pending child of this parent as replied
      db.prepare(`
        UPDATE sessions SET delegation_status = 'replied'
        WHERE session_id = (
          SELECT session_id FROM sessions
          WHERE reply_to_session_id = ? AND delegation_status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1
        )
      `).run(sessionId);
    }
  } catch { /* non-critical */ }

  const agentType = (session as typeof session & { agent_type?: string }).agent_type ?? "claude";

  if (agentType === "forge") {
    const { parseForgeConvPath } = await import("@/lib/forge-scanner");
    const conversationId = parseForgeConvPath(session.jsonl_path) ?? sessionId;
    const model = (session as typeof session & { model?: string | null }).model || undefined;
    const stream = getOrchestrator().resumeForge(conversationId, message, session.project_path, model);
    return sseResponse(stream);
  }

  if (agentType === "codex") {
    // Codex is a TUI — open terminal with `codex resume SESSION_ID "message"`
    const { getCodexPath } = await import("@/lib/codex-bin");
    const { openInTerminal } = await import("@/lib/terminal-launcher");
    const { getSetting } = await import("@/lib/db");
    const bin = getCodexPath();
    const codexSkipFlag = getSetting("dangerously_skip_permissions") === "true" ? " --dangerously-bypass-approvals-and-sandbox" : "";
    const safeMsg = message.replace(/"/g, '\\"');
    const shellCmd = `cd "${session.project_path}" && "${bin}"${codexSkipFlag} resume "${sessionId}" "${safeMsg}"`;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const { terminal } = await openInTerminal(shellCmd);
          controller.enqueue(`data: ${JSON.stringify({ type: "status", status: `Codex opened in ${terminal}` })}\n\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
        }
        controller.enqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Auto-kill terminal sessions if setting is enabled
  const autoKill = getSetting("auto_kill_terminal_on_reply") === "true";
  if (autoKill) {
    killSessionProcesses(sessionId);
    await new Promise((r) => setTimeout(r, 500));
  }

  const stream = getOrchestrator().resume(sessionId, message, session.project_path, verbose);
  return sseResponse(stream);
}
