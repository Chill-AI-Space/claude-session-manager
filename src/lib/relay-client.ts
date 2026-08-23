/**
 * Relay Client — connects local Session Manager to the CF Worker relay.
 *
 * When enabled, opens a WebSocket to the relay server. Remote callers
 * can then send commands (start, resume, stop, status, enqueue) which
 * are forwarded here and executed via the orchestrator.
 */
import WebSocket from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import { getSetting } from "./db";
import { getOrchestrator } from "./orchestrator";
import { getDb, logAction } from "./db";
import * as dlog from "./debug-logger";
import type { SessionRow } from "./types";
import { detectActiveClaudeSessions } from "./process-detector";
import { getTTY, sendTextToTerminalTTY } from "./macos-terminal-control";
import { buildResumeShellCommand, buildStartShellCommand } from "./session-terminal";
import { openInTerminal } from "./terminal-launcher";
import { claudeProjectsDir } from "./utils";
import { getLiveSessionFromPidMap } from "./session-pid-map";

/**
 * Find a session's project_path by scanning ~/.claude/projects for
 * <sessionId>.jsonl when it isn't in the local DB yet — e.g. a session
 * just started via the relay's own "start" action, before the background
 * scanner has indexed it.
 */
function findSessionProjectPathOnDisk(sessionId: string): string | null {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const jsonlPath = path.join(root, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;
    try {
      const firstLines = fs.readFileSync(jsonlPath, "utf-8").split("\n", 20);
      for (const line of firstLines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) return obj.cwd as string;
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

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
  createIfMissing?: boolean;
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
        const resolvedPath = path.resolve(cmd.projectPath);
        if (!resolvedPath.startsWith(os.homedir())) {
          return { error: "Path must be within home directory", status: 403 };
        }
        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isDirectory()) {
            return { error: "Path exists and is not a directory", status: 400 };
          }
        } catch {
          // Doesn't exist yet — create it. cmd.createIfMissing gates this so
          // a plain typo in an existing-project path doesn't silently start
          // a fresh empty folder instead of erroring.
          if (!cmd.createIfMissing) {
            return { error: "Path does not exist", status: 404 };
          }
          fs.mkdirSync(resolvedPath, { recursive: true });
          logAction("service", "relay_start_created_folder", resolvedPath);
        }
        // Fresh interactive session (not headless) — same reasoning as resume:
        // a terminal window the user can keep driving, not a fire-and-forget stream.
        const shellCmd = buildStartShellCommand(resolvedPath, cmd.message);
        const { terminal } = await openInTerminal(shellCmd, { cwd: resolvedPath });
        logAction("service", "relay_start_opened", `${terminal} ${resolvedPath}`);
        return { ok: true, terminal, projectPath: resolvedPath, action: "start" };
      }

      case "list_projects": {
        const basePath = path.resolve(cmd.projectPath || path.join(os.homedir(), "Code"));
        if (!basePath.startsWith(os.homedir())) {
          return { error: "Path must be within home directory", status: 403 };
        }
        try {
          const entries = fs
            .readdirSync(basePath, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
            .map((e) => e.name)
            .sort();
          return { ok: true, basePath, projects: entries, action: "list_projects" };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err), status: 404 };
        }
      }

      case "resume": {
        if (!cmd.sessionId || !cmd.message) {
          return { error: "sessionId and message required", status: 400 };
        }
        const db = getDb();
        let session = db
          .prepare("SELECT * FROM sessions WHERE session_id = ?")
          .get(cmd.sessionId) as SessionRow | undefined;
        if (!session) {
          // Not indexed yet (e.g. just started via relay "start", scanner
          // hasn't caught up) — fall back to reading it straight off disk.
          const projectPath = findSessionProjectPathOnDisk(cmd.sessionId);
          if (!projectPath) {
            return { error: "Session not found", status: 404 };
          }
          session = { session_id: cmd.sessionId, project_path: projectPath } as SessionRow;
          logAction("service", "relay_resume_session_from_disk", projectPath, cmd.sessionId);
        }

        // If the session is currently open in a live terminal, type the reply
        // straight into it — never spawn a second process against the same
        // session_id, since Claude Code forks the transcript when two
        // processes both --resume the same session.
        // The PID map (written by the Stop hook from its own parent PID) is
        // authoritative and unambiguous; detectActiveClaudeSessions() guesses
        // by most-recently-modified transcript in a shared cwd, which
        // misattributes when several sessions share a working directory.
        const fromPidMap = getLiveSessionFromPidMap(cmd.sessionId);
        const live = fromPidMap ? { pid: fromPidMap.pid } : detectActiveClaudeSessions().find((p) => p.sessionId === cmd.sessionId);
        const tty = fromPidMap ? fromPidMap.tty : live ? getTTY(live.pid) : null;
        if (tty) {
          // "busy" means Claude is mid-turn (visible "esc to interrupt") —
          // wait it out rather than fork a competing window over it.
          let injected = sendTextToTerminalTTY({ tty, text: cmd.message });
          for (let attempt = 0; injected.reason === "busy" && attempt < 5; attempt++) {
            await new Promise((r) => setTimeout(r, 4000));
            injected = sendTextToTerminalTTY({ tty, text: cmd.message });
          }
          if (injected.ok) {
            logAction("service", "relay_resume_injected", `${injected.terminal ?? ""} tty:${tty}`, cmd.sessionId);
            return { ok: true, mode: "injected", terminal: injected.terminal, action: "resume" };
          }
          logAction("service", "relay_resume_inject_failed", injected.error ?? injected.reason ?? "unknown", cmd.sessionId);
          // The process is still alive (detectActiveClaudeSessions found it) —
          // never fall back to opening a second --resume process against it,
          // that's exactly the fork we're avoiding. Report failure instead.
          return { error: `Session is live but reply could not be delivered (${injected.reason ?? "unknown"})`, status: 409 };
        }
        if (live) {
          // Process is alive but has no discoverable TTY (e.g. no controlling
          // terminal) — still refuse to open a second --resume against it.
          return { error: "Session is live but has no controllable terminal; reply not delivered", status: 409 };
        }

        // No active process for this session — open a fresh interactive terminal,
        // resuming with the message as the initial prompt (not headless -p).
        const shellCmd = buildResumeShellCommand(session, cmd.message);
        const { terminal } = await openInTerminal(shellCmd, { cwd: session.project_path });
        logAction("service", "relay_resume_opened", terminal, cmd.sessionId);
        return { ok: true, mode: "opened", terminal, action: "resume" };
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
