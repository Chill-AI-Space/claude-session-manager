/**
 * Relay Client — connects local Session Manager to the CF Worker relay.
 *
 * When enabled, opens a WebSocket to the relay server. Remote callers
 * can then send commands (start, resume, stop, status, enqueue) which
 * are forwarded here and executed via the orchestrator.
 */
import WebSocket from "ws";
import { getSetting } from "./db";
import { getOrchestrator } from "./orchestrator";
import { getDb, logAction } from "./db";
import * as dlog from "./debug-logger";
import type { SessionRow } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

interface RelayCommand {
  reqId: string;
  action: string;
  sessionId?: string;
  projectPath?: string;
  message?: string;
  type?: string;
  priority?: string;
  delayMs?: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60_000;
  private destroyed = false;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get nodeId(): string {
    return getSetting("relay_node_id");
  }

  get serverUrl(): string {
    return getSetting("relay_server_url") || "wss://csm-relay.chillai.workers.dev";
  }

  connect(): void {
    if (this.destroyed) return;
    if (!getSetting("relay_enabled") || getSetting("relay_enabled") !== "true") return;

    const nodeId = this.nodeId;
    if (!nodeId) {
      dlog.warn("relay", "relay_enabled but no relay_node_id set");
      return;
    }

    const url = `${this.serverUrl}/node/${nodeId}/ws`;
    dlog.info("relay", `connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      dlog.error("relay", `WebSocket create failed: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      dlog.info("relay", "connected");
      logAction("service", "relay_connected", this.serverUrl);
      this.reconnectDelay = 1000; // reset backoff

      // Heartbeat every 30s to keep connection alive
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
        }
      }, 30_000);
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data.toString()).catch((err) => {
        dlog.error("relay", `unhandled message error: ${err}`);
      });
    });

    this.ws.on("close", (code, reason) => {
      dlog.info("relay", `disconnected: ${code} ${reason}`);
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      dlog.error("relay", `websocket error: ${err.message}`);
      // close event will fire after this
    });
  }

  disconnect(): void {
    this.destroyed = false; // allow future reconnect
    this.cleanup();
    if (this.ws) {
      try { this.ws.close(1000, "manual disconnect"); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    dlog.info("relay", "disconnected (manual)");
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
  }

  // ── Command handling ──────────────────────────────────────────────────────

  private async handleMessage(raw: string): Promise<void> {
    let cmd: RelayCommand;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return;
    }

    if (!cmd.reqId || !cmd.action) return;

    dlog.info("relay", `received command: ${cmd.action}`, { reqId: cmd.reqId, sessionId: cmd.sessionId });

    try {
      const result = await this.executeCommand(cmd);
      this.send({ reqId: cmd.reqId, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dlog.error("relay", `command failed: ${msg}`, { reqId: cmd.reqId });
      this.send({ reqId: cmd.reqId, error: msg, status: 500 });
    }
  }

  private async executeCommand(cmd: RelayCommand): Promise<Record<string, unknown>> {
    const orch = getOrchestrator();

    switch (cmd.action) {
      case "start": {
        if (!cmd.projectPath || !cmd.message) {
          return { error: "projectPath and message required", status: 400 };
        }
        // Use enqueue for fire-and-forget (orch.start() returns an SSE stream
        // that crashes the WebSocket if nobody reads it)
        const taskId = orch.enqueue({
          sessionId: `start-${Date.now()}`,
          type: "start",
          message: cmd.message,
          priority: "normal",
        });
        logAction("service", "relay_start", cmd.projectPath);
        return { ok: true, taskId, action: "start" };
      }

      case "resume": {
        if (!cmd.sessionId || !cmd.message) {
          return { error: "sessionId and message required", status: 400 };
        }
        const db = getDb();
        const session = db
          .prepare("SELECT project_path FROM sessions WHERE session_id = ?")
          .get(cmd.sessionId) as { project_path: string } | undefined;
        if (!session) {
          return { error: "Session not found", status: 404 };
        }
        // Use enqueue for fire-and-forget (orch.resume() returns an SSE stream
        // that crashes the WebSocket if nobody reads it)
        const taskId = orch.enqueue({
          sessionId: cmd.sessionId,
          type: "resume",
          message: cmd.message,
          priority: "normal",
        });
        logAction("service", "relay_resume", cmd.message.slice(0, 100), cmd.sessionId);
        return { ok: true, taskId, sessionId: cmd.sessionId, action: "resume" };
      }

      case "stop": {
        if (!cmd.sessionId) {
          return { error: "sessionId required", status: 400 };
        }
        const result = orch.stop(cmd.sessionId);
        logAction("service", "relay_stop", `killed:${result.killed}`, cmd.sessionId);
        return { ok: true, ...result, action: "stop" };
      }

      case "status": {
        return {
          queue: orch.getQueueStatus(),
          sessions: orch.getAllStates(),
          action: "status",
        };
      }

      case "enqueue": {
        if (!cmd.sessionId || !cmd.type) {
          return { error: "sessionId and type required", status: 400 };
        }
        const taskId = orch.enqueue({
          sessionId: cmd.sessionId,
          type: cmd.type as "start" | "resume" | "crash_retry" | "stall_continue" | "permission_escalation",
          message: cmd.message,
          priority: (cmd.priority as "high" | "normal" | "low") || "normal",
          delayMs: cmd.delayMs || 0,
        });
        return { ok: true, taskId, action: "enqueue" };
      }

      default:
        return { error: `Unknown action: ${cmd.action}`, status: 400 };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return; // already scheduled

    // Check if relay is still enabled
    if (getSetting("relay_enabled") !== "true") return;

    dlog.info("relay", `reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}

// ── Singleton (survives hot reload) ──────────────────────────────────────────

const GLOBAL_KEY = "__relayClient";

export function getRelayClient(): RelayClient {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new RelayClient();
  }
  return g[GLOBAL_KEY] as RelayClient;
}

/**
 * Initialize the relay client if relay is enabled in settings.
 * Call this once at server startup.
 */
export function initRelayIfEnabled(): void {
  if (getSetting("relay_enabled") === "true") {
    getRelayClient().connect();
  }
}

export type { RelayClient };
