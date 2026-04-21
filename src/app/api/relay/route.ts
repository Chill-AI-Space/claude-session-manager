import { NextRequest } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { getRelayClient } from "@/lib/relay-client";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/** GET /api/relay — relay status */
export async function GET() {
  const client = getRelayClient();
  return Response.json({
    enabled: getSetting("relay_enabled") === "true",
    connected: client.connected,
    nodeId: getSetting("relay_node_id") || null,
    serverUrl: getSetting("relay_server_url") || "wss://csm-relay.chillai.workers.dev",
  });
}

/** POST /api/relay — enable/disable relay, generate nodeId */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  const client = getRelayClient();

  switch (action) {
    case "enable": {
      // Generate nodeId if not set
      let nodeId = getSetting("relay_node_id");
      if (!nodeId) {
        nodeId = randomUUID();
        setSetting("relay_node_id", nodeId);
      }
      setSetting("relay_enabled", "true");
      client.connect();
      return Response.json({ ok: true, nodeId, enabled: true });
    }

    case "disable": {
      setSetting("relay_enabled", "false");
      client.disconnect();
      return Response.json({ ok: true, enabled: false });
    }

    case "regenerate": {
      const nodeId = randomUUID();
      setSetting("relay_node_id", nodeId);
      // Reconnect with new ID
      if (getSetting("relay_enabled") === "true") {
        client.disconnect();
        client.connect();
      }
      return Response.json({ ok: true, nodeId });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
