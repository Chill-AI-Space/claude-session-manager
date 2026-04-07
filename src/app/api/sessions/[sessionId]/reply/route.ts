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
    const bin = getCodexPath();
    const safeMsg = message.replace(/"/g, '\\"');
    const shellCmd = `cd "${session.project_path}" && "${bin}" resume "${sessionId}" "${safeMsg}"`;
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
