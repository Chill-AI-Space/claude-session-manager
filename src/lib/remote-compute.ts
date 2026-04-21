/**
 * Remote Compute — proxy layer for routing session operations to remote VMs.
 *
 * When `default_compute_node` is set, new sessions run on the remote VM.
 * Session-specific operations (reply, kill, view) are routed based on
 * the `?node=nodeId` query param passed by the UI.
 *
 * Transport: Tailscale (direct HTTP, P2P encrypted) preferred.
 * CF Relay works for fire-and-forget but not for SSE streaming.
 */
import { getSetting } from "./db";
import { getRemoteNode, getRemoteNodes, type RemoteNode } from "./remote-nodes";
import * as dlog from "./debug-logger";

// ── Compute node resolution ─────────────────────────────────────────────────

/**
 * Get the default compute node for new sessions.
 * Returns null if sessions should run locally.
 */
export function getComputeNode(): RemoteNode | null {
  const nodeId = getSetting("default_compute_node");
  if (!nodeId) return null;
  return getRemoteNode(nodeId) ?? null;
}

/**
 * Resolve a node by ID. Used when the UI passes `?node=nodeId`.
 */
export function resolveNode(nodeId: string | null | undefined): RemoteNode | null {
  if (!nodeId) return null;
  return getRemoteNode(nodeId) ?? null;
}

/**
 * Get the base HTTP URL for direct communication with a remote node.
 * Only Tailscale (direct HTTP) is supported for SSE streaming.
 */
export function getNodeBaseUrl(node: RemoteNode): string | null {
  if (node.tailscale) {
    return node.tailscale.startsWith("http") ? node.tailscale : `http://${node.tailscale}`;
  }
  // CF relay doesn't support arbitrary HTTP proxy — only fire-and-forget via WS
  return null;
}

// ── SSE proxy ───────────────────────────────────────────────────────────────

const SSE_TIMEOUT_MS = 300_000; // 5 min — sessions can run long

/**
 * Proxy an SSE-returning endpoint from a remote node.
 * Injects a `remote_node` event at the start so the UI knows this is remote.
 *
 * Returns a ReadableStream suitable for `new Response(stream, { headers: SSE_HEADERS })`.
 */
export async function proxySSE(
  node: RemoteNode,
  path: string,
  body: unknown,
): Promise<ReadableStream> {
  const base = getNodeBaseUrl(node);
  if (!base) {
    throw new Error(`Node "${node.name}" has no Tailscale address — SSE proxy requires direct HTTP`);
  }

  const url = `${base}${path}`;
  dlog.info("remote-compute", `SSE proxy → ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("sse-timeout"), SSE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    dlog.error("remote-compute", `SSE proxy fetch failed: ${msg}`);
    throw new Error(`Cannot reach remote node "${node.name}": ${msg}`);
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new Error(`Remote node returned ${res.status}: ${text}`);
  }

  // Pipe through with an injected `remote_node` event at the start
  const encoder = new TextEncoder();
  const reader = res.body.getReader();
  const nodeEvent = encoder.encode(
    `data: ${JSON.stringify({ type: "remote_node", nodeId: node.id, nodeName: node.name })}\n\n`
  );

  let injected = false;

  return new ReadableStream({
    async pull(ctrl) {
      // Inject remote_node event before first real data
      if (!injected) {
        ctrl.enqueue(nodeEvent);
        injected = true;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          ctrl.close();
          return;
        }
        ctrl.enqueue(value);
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        dlog.error("remote-compute", `SSE proxy read error: ${msg}`);
        ctrl.error(err);
      }
    },
    cancel() {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    },
  });
}

// ── JSON proxy ──────────────────────────────────────────────────────────────

const JSON_TIMEOUT_MS = 30_000;

/**
 * Proxy a JSON API call to a remote node.
 * Returns the raw Response for flexible handling.
 */
export async function proxyJSON(
  node: RemoteNode,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const base = getNodeBaseUrl(node);
  if (!base) {
    throw new Error(`Node "${node.name}" has no Tailscale address`);
  }

  const url = `${base}${path}`;
  dlog.debug("remote-compute", `JSON proxy ${method} → ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), JSON_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Remote session list ─────────────────────────────────────────────────────

export interface RemoteSessionInfo {
  sessions: Record<string, unknown>[];
  total: number;
  nodeId: string;
  nodeName: string;
  error?: string;
}

/**
 * Fetch the session list from a remote node.
 * Each session is tagged with `_remote`, `_nodeId`, `_nodeName`.
 * Uses a short timeout (3s) to avoid blocking the sidebar.
 */
export async function fetchRemoteSessions(
  node: RemoteNode,
  opts: { limit?: number; search?: string } = {},
): Promise<RemoteSessionInfo> {
  const base = getNodeBaseUrl(node);
  if (!base) {
    return { sessions: [], total: 0, nodeId: node.id, nodeName: node.name, error: "No Tailscale address" };
  }

  try {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.search) params.set("search", opts.search);
    params.set("include_remote", "false"); // prevent recursive remote fetching
    const qs = params.toString();

    const url = `${base}/api/sessions${qs ? `?${qs}` : ""}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("remote-list-timeout"), 3_000);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { sessions: [], total: 0, nodeId: node.id, nodeName: node.name, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as { sessions?: Record<string, unknown>[]; total?: number };
    const sessions = (data.sessions || []).map((s) => ({
      ...s,
      _remote: true,
      _nodeId: node.id,
      _nodeName: node.name,
    }));
    return { sessions, total: data.total || 0, nodeId: node.id, nodeName: node.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dlog.warn("remote-compute", `Failed to fetch sessions from "${node.name}": ${msg}`);
    return { sessions: [], total: 0, nodeId: node.id, nodeName: node.name, error: msg };
  }
}

/**
 * Fetch sessions from ALL registered remote nodes in parallel.
 */
export async function fetchAllRemoteSessions(
  opts: { limit?: number; search?: string } = {},
): Promise<RemoteSessionInfo[]> {
  const nodes = getRemoteNodes();
  if (nodes.length === 0) return [];

  return Promise.all(nodes.map((node) => fetchRemoteSessions(node, opts)));
}
