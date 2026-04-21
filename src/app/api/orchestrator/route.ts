import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { resolveNode, proxyJSON } from "@/lib/remote-compute";
import { getRemoteNodes } from "@/lib/remote-nodes";

export const dynamic = "force-dynamic";

/** GET /api/orchestrator — return queue status + session states (local + remote) */
export async function GET(request: NextRequest) {
  const orch = getOrchestrator();
  const local = {
    queue: orch.getQueueStatus(),
    sessions: orch.getAllStates(),
  };

  // Optionally include remote orchestrator state
  const includeRemote = request.nextUrl.searchParams.get("include_remote") !== "false";
  if (!includeRemote) {
    return Response.json(local);
  }

  const nodes = getRemoteNodes();
  const remoteStates: Record<string, unknown>[] = [];

  await Promise.all(
    nodes.map(async (node) => {
      try {
        const res = await proxyJSON(node, "/api/orchestrator");
        if (res.ok) {
          const data = await res.json();
          remoteStates.push({ nodeId: node.id, nodeName: node.name, ...data as object });
        }
      } catch {
        remoteStates.push({ nodeId: node.id, nodeName: node.name, error: "unreachable" });
      }
    })
  );

  return Response.json({
    ...local,
    remote: remoteStates.length > 0 ? remoteStates : undefined,
  });
}

/** POST /api/orchestrator — enqueue a task (local or remote) */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { type, sessionId, message, priority, delayMs, nodeId } = body;

  if (!type || !sessionId) {
    return Response.json({ error: "type and sessionId are required" }, { status: 400 });
  }

  // If nodeId specified, forward to remote
  const node = resolveNode(nodeId);
  if (node) {
    try {
      const res = await proxyJSON(node, "/api/orchestrator", "POST", {
        type, sessionId, message, priority, delayMs,
      });
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote enqueue failed: ${msg}` }, { status: 502 });
    }
  }

  // Local enqueue
  try {
    const taskId = getOrchestrator().enqueue({
      sessionId,
      type,
      message,
      priority,
      delayMs,
    });
    return Response.json({ taskId, ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
