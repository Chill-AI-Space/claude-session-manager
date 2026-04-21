import { NextRequest } from "next/server";
import { getComputeNode, getNodeBaseUrl, proxyJSON } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

/**
 * GET /api/remote-compute — check remote compute status
 *
 * Returns:
 * - enabled: whether a default compute node is configured
 * - node: the compute node info (if enabled)
 * - reachable: whether the node responds to health check
 * - orchestrator: remote orchestrator state (if reachable)
 */
export async function GET(_request: NextRequest) {
  const node = getComputeNode();

  if (!node) {
    return Response.json({ enabled: false });
  }

  const base = getNodeBaseUrl(node);
  const info: Record<string, unknown> = {
    enabled: true,
    node: {
      id: node.id,
      name: node.name,
      tailscale: node.tailscale,
      hasDirectHttp: !!base,
    },
  };

  // Health check
  if (base) {
    try {
      const res = await proxyJSON(node, "/api/orchestrator");
      if (res.ok) {
        const data = await res.json();
        info.reachable = true;
        info.orchestrator = data;
      } else {
        info.reachable = false;
        info.error = `HTTP ${res.status}`;
      }
    } catch (err) {
      info.reachable = false;
      info.error = err instanceof Error ? err.message : String(err);
    }
  } else {
    info.reachable = false;
    info.error = "No Tailscale address configured — direct HTTP required for SSE proxy";
  }

  return Response.json(info);
}
