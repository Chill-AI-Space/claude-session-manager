import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse } from "@/lib/claude-runner";
import { logAction } from "@/lib/db";
import { getComputeNode, resolveNode, proxySSE } from "@/lib/remote-compute";
import { SSE_HEADERS } from "@/lib/claude-runner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message, correlationId, verbose, model, agent } = body as {
    path: string;
    message: string;
    correlationId?: string;
    verbose?: boolean;
    model?: string;
    agent?: string;
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
    const stream = getOrchestrator().startForge(projectPath, message.trim());
    return sseResponse(stream);
  }

  const stream = getOrchestrator().start(projectPath, message.trim(), correlationId, verbose ?? false, model);
  return sseResponse(stream);
}
