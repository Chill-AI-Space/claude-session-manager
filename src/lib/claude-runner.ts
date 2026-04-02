/**
 * Shared helpers for spawning Claude CLI processes.
 * - `runClaudeOneShot` — fire prompt, collect text output, return string
 * - `createSSEStream` — spawn Claude with stream-json, return SSE ReadableStream + Response
 */
import { ChildProcess } from "child_process";
import spawn from "cross-spawn";
import { getClaudePath } from "./claude-bin";
import { getCleanEnv } from "./utils";
import { getSetting } from "./db";
import * as dlog from "./debug-logger";

/**
 * Build env for Claude CLI spawn.
 * When claude_model starts with "z.ai-", injects ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
 * so Claude CLI routes through Z.AI (which maps to GLM models).
 */
function getClaudeSpawnEnv(): NodeJS.ProcessEnv {
  const env = getCleanEnv();
  const model = getSetting("claude_model") || "";
  if (model.startsWith("z.ai-")) {
    const key = getSetting("zai_api_key");
    if (key) {
      env.ANTHROPIC_AUTH_TOKEN = key;
      env.ANTHROPIC_BASE_URL = getSetting("zai_base_url") || process.env.ZAI_BASE_URL || "https://api.z.ai/api/anthropic";
    }
  }
  return env;
}

// ── One-shot runner (title generation, learnings extraction, etc.) ───────────

export function runClaudeOneShot(opts: {
  prompt: string;
  args?: string[];
  timeoutMs?: number;
}): Promise<string> {
  const { prompt, args = [], timeoutMs = 90_000 } = opts;
  const env = getClaudeSpawnEnv();

  return new Promise((resolve, reject) => {
    dlog.debug("claude-runner", `oneshot spawn: ${args.join(" ")}`, { timeoutMs });
    const proc = spawn(getClaudePath(), args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill(); // SIGTERM on Unix, TerminateProcess on Windows
      dlog.warn("claude-runner", `oneshot timed out after ${timeoutMs}ms`);
      reject(new Error(`Claude process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        dlog.debug("claude-runner", `oneshot completed ok (${stdout.length} chars)`);
        resolve(stdout.trim());
      } else {
        dlog.error("claude-runner", `oneshot exited ${code}`, { stderr: stderr.slice(0, 300) });
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      dlog.error("claude-runner", `oneshot spawn error: ${err.message}`);
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── SSE streaming helper ─────────────────────────────────────────────────────

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export interface SSEStreamOptions {
  /** Args for `claude` CLI */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Called for each parsed JSON line from stdout. Use `send()` to emit SSE events. */
  onLine: (obj: Record<string, unknown>, send: (data: Record<string, unknown>) => void) => void;
  /** Called when the process closes. Optional final cleanup. */
  onClose?: (send: (data: Record<string, unknown>) => void) => void;
  /** Enable keepalive pings (default: true) */
  keepalive?: boolean;
  /** Called with the spawned ChildProcess for external control (e.g. kill on abort) */
  onProc?: (proc: ChildProcess) => void;
}

/**
 * Create a ReadableStream that spawns Claude CLI with `--output-format stream-json`
 * and forwards parsed events as SSE `data:` lines.
 */
export function createSSEStream(opts: SSEStreamOptions): ReadableStream {
  const { args, cwd, onLine, onClose, keepalive = true, onProc } = opts;
  const env = getClaudeSpawnEnv();
  const encoder = new TextEncoder();

  let closed = false;
  let keepaliveTimer: NodeJS.Timeout | undefined;

  return new ReadableStream({
    start(controller) {

      function send(data: Record<string, unknown>) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      function sendRaw(text: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      }

      function close() {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch { /* already closed */ }
      }

      dlog.info("claude-runner", `SSE stream spawn: ${args.join(" ")}`, { cwd });
      const isWin = process.platform === "win32";
      const proc = spawn(getClaudePath(), args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWin, // detached on Unix to survive parent exit; not needed on Windows
        windowsHide: true,
      });

      // Let the process outlive the parent — if the SSE client disconnects,
      // Claude keeps running and writes results to JSONL.
      proc.unref();

      onProc?.(proc);

      // Keepalive pings
      if (keepalive) {
        keepaliveTimer = setInterval(() => {
          if (closed) {
            clearInterval(keepaliveTimer);
            return;
          }
          sendRaw(`: keepalive\n\n`);
        }, 15_000);
      }

      let buffer = "";

      proc.stdout!.on("data", (data: Buffer) => {
        if (closed) return;
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            onLine(obj, send);
          } catch {
            // skip non-JSON lines
          }
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString();
        if (!text.includes("Warning:")) {
          send({ type: "error", text });
        }
      });

      proc.on("close", (code) => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);

        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer);
            onLine(obj, send);
          } catch { /* ignore */ }
        }

        onClose?.(send);

        if (code !== 0 && code !== null) {
          dlog.warn("claude-runner", `SSE process exited ${code}`, { cwd });
          send({ type: "error", text: `Process exited with code ${code}` });
        } else {
          dlog.debug("claude-runner", "SSE process completed ok");
        }
        close();
      });

      proc.on("error", (err) => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        dlog.error("claude-runner", `SSE spawn error: ${err.message}`);
        send({ type: "error", text: err.message });
        close();
      });
    },
    cancel() {
      closed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    },
  });
}

/** Create an SSE Response from a ReadableStream */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, { headers: SSE_HEADERS });
}
