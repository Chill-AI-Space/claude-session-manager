import { NextRequest } from "next/server";
import { getRemoteNode, sendCommand, type RemoteCommand } from "@/lib/remote-nodes";

export const dynamic = "force-dynamic";

/**
 * POST /api/remote-nodes/[nodeId]/proxy
 *
 * Proxy a command to a remote CSM node.
 * Tries preferred transport (Tailscale/Relay), falls back to the other.
 *
 * Body: { action, sessionId?, projectPath?, message?, type?, priority?, delayMs? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ nodeId: string }> }
) {
  const { nodeId } = await params;
  const node = getRemoteNode(nodeId);
  if (!node) {
    return Response.json({ error: "Remote node not found" }, { status: 404 });
  }

  const body = await request.json();
  const { action, ...rest } = body;

  if (!action) {
    return Response.json({ error: "action is required" }, { status: 400 });
  }

  const cmd: RemoteCommand = { action, ...rest };
  const result = await sendCommand(node, cmd);

  return Response.json({
    ...result,
    node: { id: node.id, name: node.name },
  }, { status: result.ok ? 200 : 502 });
}
