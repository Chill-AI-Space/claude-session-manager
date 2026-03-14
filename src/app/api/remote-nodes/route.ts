import { NextRequest } from "next/server";
import {
  getRemoteNodes,
  addRemoteNode,
  updateRemoteNode,
  removeRemoteNode,
  pingAllNodes,
  type RemoteNode,
} from "@/lib/remote-nodes";

export const dynamic = "force-dynamic";

/** GET /api/remote-nodes — list all remote nodes */
export async function GET(request: NextRequest) {
  const ping = request.nextUrl.searchParams.get("ping") === "true";
  const nodes = getRemoteNodes();

  if (ping) {
    const statuses = await pingAllNodes();
    const nodesWithStatus = nodes.map((n) => ({
      ...n,
      online: statuses[n.id] ?? n.online ?? false,
    }));
    return Response.json(nodesWithStatus);
  }

  return Response.json(nodes);
}

/** POST /api/remote-nodes — add a new remote node */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, tailscale, relayNodeId, preferred } = body;

  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  if (!tailscale && !relayNodeId) {
    return Response.json(
      { error: "At least one of tailscale or relayNodeId is required" },
      { status: 400 }
    );
  }

  const node = addRemoteNode({
    name,
    tailscale: tailscale || undefined,
    relayNodeId: relayNodeId || undefined,
    preferred: preferred || (tailscale ? "tailscale" : "relay"),
  });

  return Response.json(node, { status: 201 });
}

/** PUT /api/remote-nodes — update an existing node */
export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const node = updateRemoteNode(id, updates);
  if (!node) {
    return Response.json({ error: "Node not found" }, { status: 404 });
  }

  return Response.json(node);
}

/** DELETE /api/remote-nodes — remove a node */
export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id query param required" }, { status: 400 });
  }

  const removed = removeRemoteNode(id);
  if (!removed) {
    return Response.json({ error: "Node not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
