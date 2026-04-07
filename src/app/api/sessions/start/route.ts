import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse } from "@/lib/claude-runner";
import { logAction } from "@/lib/db";
import { getComputeNode, resolveNode, proxySSE } from "@/lib/remote-compute";
import { SSE_HEADERS } from "@/lib/claude-runner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message, correlationId, verbose, model, agent, previous_session_id, on_complete_url } = body as {
    path: string;
    message: string;
    correlationId?: string;
    verbose?: boolean;
    model?: string;
    agent?: string;
    previous_session_id?: string;
    on_complete_url?: string;
  };

  if (!projectPath || !message?.trim()) {
    return Response.json({ error: "path and message required" }, { status: 400 });
  }

  // Check if a specific node was requested, or use default compute node
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId) || getComputeNode();

  if (node) {
    // Route to remote VM
    logAction("service", "remote_session_start", JSON.stringify({ node: node.name, path: projectPath }));
    try {
      const stream = await proxySSE(node, "/api/sessions/start", {
        path: projectPath,
        message: message.trim(),
        correlationId,
        verbose: verbose ?? false,
        agent,
        model,
      });
      return new Response(stream, { headers: SSE_HEADERS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote start failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
  if (correlationId) {
    logAction("service", "session_start_api_received", JSON.stringify({ correlationId, path: projectPath }));
  }

  if (agent === "forge") {
    const stream = getOrchestrator().startForge(projectPath, message.trim(), model);
    return sseResponse(stream);
  }

  if (agent === "codex") {
    // Codex is a TUI — open in terminal and return a lightweight SSE stream
    const { getCodexPath } = await import("@/lib/codex-bin");
    const { openInTerminal } = await import("@/lib/terminal-launcher");
    const bin = getCodexPath();
    const modelFlag = model ? ` -c model="${model}"` : "";
    const safeMsg = message.trim().replace(/"/g, '\\"');
    const shellCmd = `cd "${projectPath}" && "${bin}"${modelFlag} "${safeMsg}"`;
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

  const stream = getOrchestrator().start(projectPath, message.trim(), correlationId, verbose ?? false, model, previous_session_id, on_complete_url);
  return sseResponse(stream);
}
