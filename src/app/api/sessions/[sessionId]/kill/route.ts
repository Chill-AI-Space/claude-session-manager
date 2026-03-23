import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { resolveNode, proxyJSON } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Check if this is a remote session
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);

  if (node) {
    try {
      const res = await proxyJSON(node, `/api/sessions/${sessionId}/kill`, "POST");
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote kill failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
  const result = getOrchestrator().stop(sessionId);
  return Response.json(result);
}
