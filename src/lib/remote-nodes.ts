/**
 * Remote Nodes — registry + client for sending commands to remote CSM instances.
 *
 * Each remote node can be reached via:
 * 1. Tailscale (direct HTTP to node.tailnet:port) — fast, P2P, encrypted
 * 2. Cloudflare Relay (via relay worker + nodeId) — works from anywhere
 *
 * The client tries the preferred transport first, falls back to the other.
 */
import { getSetting, setSetting } from "./db";
import * as dlog from "./debug-logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RemoteNode {
  /** Unique ID (auto-generated) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Tailscale MagicDNS address + port, e.g. "home-server.tailnet.ts.net:3000" */
  tailscale?: string;
  /** Relay node UUID (for Cloudflare Worker relay) */
  relayNodeId?: string;
  /** Which transport to try first */
  preferred: "tailscale" | "relay";
  /** Last successful ping timestamp */
  lastSeen?: number;
  /** Whether node is reachable (updated by health check) */
  online?: boolean;
}

export type RemoteAction = "start" | "resume" | "stop" | "status" | "enqueue";

export interface RemoteCommand {
  action: RemoteAction;
  sessionId?: string;
  projectPath?: string;
  message?: string;
  type?: string;
  priority?: string;
  delayMs?: number;
}

export interface RemoteResult {
  ok: boolean;
  transport: "tailscale" | "relay";
  data?: Record<string, unknown>;
  error?: string;
}

// ── Registry (stored in settings as JSON) ────────────────────────────────────

const SETTINGS_KEY = "remote_nodes";

export function getRemoteNodes(): RemoteNode[] {
  const raw = getSetting(SETTINGS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function getRemoteNode(id: string): RemoteNode | undefined {
  return getRemoteNodes().find((n) => n.id === id);
}

export function saveRemoteNodes(nodes: RemoteNode[]): void {
  setSetting(SETTINGS_KEY, JSON.stringify(nodes));
}

export function addRemoteNode(node: Omit<RemoteNode, "id">): RemoteNode {
  const nodes = getRemoteNodes();
  const newNode: RemoteNode = {
    ...node,
    id: `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  };
  nodes.push(newNode);
  saveRemoteNodes(nodes);
  return newNode;
}

export function updateRemoteNode(id: string, updates: Partial<RemoteNode>): RemoteNode | null {
  const nodes = getRemoteNodes();
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  nodes[idx] = { ...nodes[idx], ...updates, id }; // id is immutable
  saveRemoteNodes(nodes);
  return nodes[idx];
}

export function removeRemoteNode(id: string): boolean {
  const nodes = getRemoteNodes();
  const filtered = nodes.filter((n) => n.id !== id);
  if (filtered.length === nodes.length) return false;
  saveRemoteNodes(filtered);
  return true;
}

// ── Client (send commands to remote nodes) ───────────────────────────────────

const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Send a command via Tailscale (direct HTTP) */
async function sendViaTailscale(node: RemoteNode, cmd: RemoteCommand): Promise<RemoteResult> {
  if (!node.tailscale) {
    return { ok: false, transport: "tailscale", error: "No Tailscale address configured" };
  }

  const base = node.tailscale.startsWith("http") ? node.tailscale : `http://${node.tailscale}`;

  try {
    // Map actions to CSM API endpoints
    let url: string;
    let method = "POST";
    let body: string | undefined;

    switch (cmd.action) {
      case "start":
        url = `${base}/api/sessions/start`;
        body = JSON.stringify({ path: cmd.projectPath, message: cmd.message });
        break;
      case "resume":
        url = `${base}/api/sessions/${cmd.sessionId}/reply`;
        body = JSON.stringify({ message: cmd.message });
        break;
      case "stop":
        url = `${base}/api/sessions/${cmd.sessionId}/kill`;
        break;
      case "status":
        url = `${base}/api/orchestrator`;
        method = "GET";
        break;
      case "enqueue":
        url = `${base}/api/orchestrator`;
        body = JSON.stringify({
          sessionId: cmd.sessionId,
          type: cmd.type,
          message: cmd.message,
          priority: cmd.priority,
          delayMs: cmd.delayMs,
        });
        break;
      default:
        return { ok: false, transport: "tailscale", error: `Unknown action: ${cmd.action}` };
    }

    const res = await fetchWithTimeout(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
    });

    const data = await res.json();
    return { ok: res.ok, transport: "tailscale", data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dlog.warn("remote-nodes", `Tailscale failed for ${node.name}: ${msg}`);
    return { ok: false, transport: "tailscale", error: msg };
  }
}

/** Send a command via Cloudflare Relay */
async function sendViaRelay(node: RemoteNode, cmd: RemoteCommand): Promise<RemoteResult> {
  if (!node.relayNodeId) {
    return { ok: false, transport: "relay", error: "No Relay Node ID configured" };
  }

  const relayUrl = (getSetting("relay_server_url") || "wss://csm-relay.chillai.workers.dev")
    .replace("wss://", "https://")
    .replace("ws://", "http://");

  try {
    const url = `${relayUrl}/node/${node.relayNodeId}/${cmd.action}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: cmd.sessionId,
        projectPath: cmd.projectPath,
        message: cmd.message,
        type: cmd.type,
        priority: cmd.priority,
        delayMs: cmd.delayMs,
      }),
    });

    const data = await res.json();
    return { ok: res.ok, transport: "relay", data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dlog.warn("remote-nodes", `Relay failed for ${node.name}: ${msg}`);
    return { ok: false, transport: "relay", error: msg };
  }
}

/**
 * Send a command to a remote node.
 * Tries preferred transport first, falls back to the other if it fails.
 */
export async function sendCommand(node: RemoteNode, cmd: RemoteCommand): Promise<RemoteResult> {
  const primary = node.preferred === "tailscale" ? sendViaTailscale : sendViaRelay;
  const fallback = node.preferred === "tailscale" ? sendViaRelay : sendViaTailscale;

  const result = await primary(node, cmd);
  if (result.ok) {
    // Update lastSeen
    updateRemoteNode(node.id, { lastSeen: Date.now(), online: true });
    return result;
  }

  dlog.info("remote-nodes", `${node.preferred} failed for ${node.name}, trying fallback`);
  const fallbackResult = await fallback(node, cmd);
  if (fallbackResult.ok) {
    updateRemoteNode(node.id, { lastSeen: Date.now(), online: true });
  }
  return fallbackResult;
}

/**
 * Ping a remote node to check if it's reachable.
 */
export async function pingNode(node: RemoteNode): Promise<RemoteResult> {
  return sendCommand(node, { action: "status" });
}

/**
 * Ping all remote nodes and update their online status.
 */
export async function pingAllNodes(): Promise<Record<string, boolean>> {
  const nodes = getRemoteNodes();
  const results: Record<string, boolean> = {};

  await Promise.all(
    nodes.map(async (node) => {
      const result = await pingNode(node);
      results[node.id] = result.ok;
      updateRemoteNode(node.id, {
        online: result.ok,
        ...(result.ok ? { lastSeen: Date.now() } : {}),
      });
    })
  );

  return results;
}
