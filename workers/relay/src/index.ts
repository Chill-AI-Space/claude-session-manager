/**
 * CSM Relay — Cloudflare Worker + Durable Object (Hibernation API)
 *
 * Allows remote callers to send commands to a local Session Manager instance.
 *
 * Flow:
 * 1. Session Manager connects via WebSocket: GET /node/:nodeId/ws
 * 2. Remote caller sends command via HTTP: POST /node/:nodeId/:action
 * 3. Worker forwards command through WebSocket to the local instance
 * 4. Local instance executes via orchestrator, sends result back through WebSocket
 * 5. Worker returns result to the remote caller
 *
 * Uses the Hibernation API so the DO can be evicted between requests
 * while keeping the WebSocket alive.
 *
 * Auth: nodeId is a UUID v4 (122 bits entropy) = knowing the ID is the auth.
 */

export interface Env {
  RELAY_NODE: DurableObjectNamespace;
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Health check
    if (path === "/" || path === "/health") {
      return corsResponse(Response.json({ status: "ok", service: "csm-relay" }));
    }

    // Route: /node/:nodeId/...
    const nodeMatch = path.match(/^\/node\/([a-f0-9-]{36})\/(ws|start|resume|stop|status|enqueue)$/);
    if (!nodeMatch) {
      return corsResponse(Response.json({ error: "Not found" }, { status: 404 }));
    }

    const [, nodeId, action] = nodeMatch;

    // Get or create the Durable Object for this nodeId
    const id = env.RELAY_NODE.idFromName(nodeId);
    const stub = env.RELAY_NODE.get(id);

    // Forward the request to the Durable Object
    const doUrl = new URL(request.url);
    doUrl.pathname = `/${action}`;
    const doRequest = new Request(doUrl.toString(), request);
    const response = await stub.fetch(doRequest);

    // Don't wrap WebSocket upgrade responses — they have a webSocket property
    // that gets lost when creating a new Response
    if (response.status === 101) return response;
    return corsResponse(response);
  },
};

// ── Durable Object: one per nodeId (Hibernation API) ─────────────────────────

export class RelayNode {
  private state: DurableObjectState;
  private pendingRequests = new Map<string, {
    resolve: (value: Response) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private requestCounter = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /** Get the currently connected node WebSocket (survives hibernation) */
  private getNodeSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets("node");
    return sockets.length > 0 ? sockets[0] : null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1); // strip leading /

    // WebSocket upgrade — local Session Manager connects here
    if (action === "ws") {
      return this.handleWebSocket(request);
    }

    // HTTP command — remote caller sends commands here
    if (request.method !== "POST") {
      return Response.json({ error: "POST required" }, { status: 405 });
    }

    const nodeSocket = this.getNodeSocket();
    if (!nodeSocket) {
      return Response.json({ error: "Node not connected" }, { status: 503 });
    }

    return this.forwardCommand(action, request, nodeSocket);
  }

  // ── WebSocket handling ──────────────────────────────────────────────────

  private handleWebSocket(request: Request): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Close previous connection if exists
    const existing = this.getNodeSocket();
    if (existing) {
      try {
        existing.close(1000, "replaced by new connection");
      } catch { /* ignore */ }
    }

    // Accept with Hibernation API — survives DO eviction
    this.state.acceptWebSocket(server, ["node"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation API handlers (called when DO wakes up) ─────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    this.handleNodeMessage(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Reject all pending requests
    for (const [reqId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(Response.json({ error: "Node disconnected" }, { status: 503 }));
      this.pendingRequests.delete(reqId);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Will be followed by webSocketClose
  }

  // ── Forward HTTP command to local node via WebSocket ────────────────────

  private async forwardCommand(action: string, request: Request, nodeSocket: WebSocket): Promise<Response> {
    const reqId = `r${++this.requestCounter}_${Date.now()}`;
    let body: Record<string, unknown> = {};

    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Send command through WebSocket
    const command = JSON.stringify({ reqId, action, ...body });

    try {
      nodeSocket.send(command);
    } catch {
      return Response.json({ error: "Failed to send to node" }, { status: 503 });
    }

    // Wait for response (timeout 60s)
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(Response.json({ error: "Timeout waiting for node response" }, { status: 504 }));
      }, 60_000);

      this.pendingRequests.set(reqId, { resolve, timer });
    });
  }

  // ── Handle response from local node ─────────────────────────────────────

  private handleNodeMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      const { reqId, ...result } = msg;

      if (reqId && this.pendingRequests.has(reqId)) {
        const pending = this.pendingRequests.get(reqId)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(reqId);

        const status = result.error ? (result.status || 500) : 200;
        pending.resolve(Response.json(result, { status }));
      }
      // If no reqId, it's a notification (heartbeat, etc.) — ignore
    } catch { /* ignore malformed */ }
  }
}

// ── CORS helper ──────────────────────────────────────────────────────────────

function corsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
