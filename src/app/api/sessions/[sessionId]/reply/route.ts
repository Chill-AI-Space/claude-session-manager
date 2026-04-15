import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import type { SessionRow } from "@/lib/types";
import { killSessionProcesses } from "@/lib/process-detector";
import { getOrchestrator } from "@/lib/orchestrator";
import { getCodexPath } from "@/lib/codex-bin";
import { openInTerminal } from "@/lib/terminal-launcher";
import { sseResponse, SSE_HEADERS } from "@/lib/claude-runner";
import { resolveNode, proxySSE } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

function ansiQuote(s: string): string {
  return "$'" +
    s
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/"/g, '\\"') +
    "'";
}

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
    let updatedChildId: string | null = null;
    if (delegatingSessionId) {
      const result = db.prepare(
        "UPDATE sessions SET delegation_status = 'replied' WHERE session_id = ? AND delegation_status = 'pending'"
      ).run(delegatingSessionId);
      if (result.changes > 0) updatedChildId = delegatingSessionId;
    } else {
      // Auto-detect: find and mark the oldest pending child of this parent
      const child = db.prepare(
        "SELECT session_id FROM sessions WHERE reply_to_session_id = ? AND delegation_status = 'pending' ORDER BY created_at ASC LIMIT 1"
      ).get(sessionId) as { session_id: string } | undefined;
      if (child) {
        db.prepare("UPDATE sessions SET delegation_status = 'replied' WHERE session_id = ?").run(child.session_id);
        updatedChildId = child.session_id;
      }
    }
    if (updatedChildId) {
      logAction("service", "delegation_replied", `child:${updatedChildId}`, sessionId);
    } else {
      logAction("service", "delegation_reply_no_child", `delegating_session_id:${delegatingSessionId ?? "none"}`, sessionId);
    }
  } catch (err) {
    logAction("service", "delegation_reply_error", String(err), sessionId);
  }

  const agentType = (session as typeof session & { agent_type?: string }).agent_type ?? "claude";

  if (agentType === "forge") {
    const { parseForgeConvPath } = await import("@/lib/forge-scanner");
    const conversationId = parseForgeConvPath(session.jsonl_path) ?? sessionId;
    const model = (session as typeof session & { model?: string | null }).model || undefined;
    const stream = getOrchestrator().resumeForge(conversationId, message, session.project_path, model);
    return sseResponse(stream);
  }

  if (agentType === "codex") {
    // Codex cannot be driven over the Claude SSE runner, so we resume the session
    // in a terminal with the reply as the initial prompt.
    db.prepare(
      "UPDATE sessions SET last_message = ?, last_message_role = 'user', modified_at = ? WHERE session_id = ?"
    ).run(message.slice(0, 1000), new Date().toISOString(), sessionId);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const bin = getCodexPath();
          const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
          const codexSkipFlag = skipPermissions ? " --dangerously-bypass-approvals-and-sandbox" : "";
          const shellCmd = `cd "${session.project_path}" && "${bin}"${codexSkipFlag} resume "${sessionId}" ${ansiQuote(message)}`;
          const { terminal } = await openInTerminal(shellCmd);
          logAction("service", "codex_reply_opened", `${terminal} msg_len:${message.length}`, sessionId);
          send({ type: "status", text: `Codex resumed in ${terminal}` });
          send({ type: "done", result: "Codex resumed", is_error: false });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          logAction("service", "codex_reply_error", text, sessionId);
          send({ type: "error", text });
        } finally {
          controller.close();
        }
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
