/**
 * SSE stream helper for Forge CLI.
 * Spawns `forge --conversation-id UUID -C path -p message`
 * and forwards plain-text output as SSE events.
 *
 * Unlike Claude (which emits JSON), Forge emits plain text:
 *   ● [HH:MM:SS] Initialize <uuid>    ← status event
 *   ● [HH:MM:SS] Execute [/bin/zsh] cmd  ← tool event
 *   regular text lines                ← assistant output
 *   ● [HH:MM:SS] Finished <uuid>      ← completion
 */
import spawn from "cross-spawn";
import { spawnSync } from "child_process";
import { getForgePath } from "./forge-bin";
import { getCleanEnv } from "./utils";
import * as dlog from "./debug-logger";

export const FORGE_STATUS_RE = /^● \[\d{2}:\d{2}:\d{2}\] (.+)$/;
export const FORGE_FINISHED_RE = /^● \[\d{2}:\d{2}:\d{2}\] Finished /;
export const FORGE_INIT_RE = /^● \[\d{2}:\d{2}:\d{2}\] (?:Initialize|Continue) /;

export interface ForgeSSEStreamOptions {
  conversationId: string;
  message: string;
  projectPath: string;
  model?: string;
  /** Called when the process closes (after done event sent) */
  onClose?: () => void;
}

/**
 * Create a ReadableStream that spawns Forge CLI and streams SSE events.
 * Emits `session_id` immediately (we control the UUID).
 */
export function createForgeSSEStream(opts: ForgeSSEStreamOptions): ReadableStream {
  const { conversationId, message, projectPath, model, onClose } = opts;
  const encoder = new TextEncoder();

  let closed = false;
  let keepaliveTimer: NodeJS.Timeout | undefined;
  let doneSent = false;

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
        clearInterval(keepaliveTimer);
        try { controller.close(); } catch { /* already closed */ }
      }

      // Emit session_id immediately — we control the UUID
      send({ type: "session_id", session_id: conversationId });

      const args = [
        "--conversation-id", conversationId,
        "-C", projectPath,
        "-p", message,
      ];

      // Set model if provided (Forge doesn't have a flag, so we set it via config)
      if (model) {
        dlog.info("forge-runner", `set model: forge config set model "${model}"`);
        spawnSync(getForgePath(), ["config", "set", "model", model], {
          env: getCleanEnv(),
          stdio: "ignore",
        });
      }

      // Rotate Gemini key before spawning (checks quota, writes working key to ~/forge/.credentials.json)
      if (process.platform !== "win32") {
        const rotatePath = `${process.env.HOME}/.claude/scripts/pm-gemini-rotate.sh`;
        const rotateResult = spawnSync("bash", [rotatePath], {
          env: getCleanEnv(),
          encoding: "utf-8",
          timeout: 35_000,
        });
        if (rotateResult.status !== 0) {
          dlog.warn("forge-runner", "pm-gemini-rotate.sh: all keys exhausted or script failed");
          send({ type: "error", text: `GEMINI_QUOTA_EXHAUSTED:${model ?? ""}` });
          close();
          return;
        }
        dlog.info("forge-runner", `pm-gemini-rotate.sh: ok (key set in credentials.json)`);
      }

      dlog.info("forge-runner", `spawn: forge ${args.slice(0, 4).join(" ")} ...`, { cwd: projectPath });

      const isWin = process.platform === "win32";
      const proc = spawn(getForgePath(), args, {
        cwd: projectPath,
        env: getCleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWin,
        windowsHide: true,
      });
      proc.unref?.();

      // Keepalive pings
      keepaliveTimer = setInterval(() => {
        if (closed) { clearInterval(keepaliveTimer); return; }
        sendRaw(`: keepalive\n\n`);
      }, 15_000);

      let buffer = "";

      proc.stdout!.on("data", (data: Buffer) => {
        if (closed) return;
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          if (FORGE_FINISHED_RE.test(line)) {
            // Forge completed
            if (!doneSent) {
              doneSent = true;
              send({ type: "done" });
            }
            continue;
          }

          if (FORGE_INIT_RE.test(line)) {
            // Skip "Initialize/Continue UUID" lines — already emitted session_id
            continue;
          }

          const statusMatch = line.match(FORGE_STATUS_RE);
          if (statusMatch) {
            // Tool/event line: "Execute [/bin/zsh] ls", "Create /path/file", etc.
            send({ type: "status", text: statusMatch[1] });
          } else {
            // Assistant text output
            send({ type: "text", text: line });
          }
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString();
        if (!text.includes("Warning:")) {
          dlog.warn("forge-runner", `stderr: ${text.slice(0, 200)}`);
          send({ type: "error", text });
        }
      });

      proc.on("close", (code) => {
        clearInterval(keepaliveTimer);

        // Flush remaining buffer
        if (buffer.trim()) {
          if (FORGE_FINISHED_RE.test(buffer)) {
            if (!doneSent) { doneSent = true; send({ type: "done" }); }
          } else if (!FORGE_INIT_RE.test(buffer)) {
            const statusMatch = buffer.match(FORGE_STATUS_RE);
            if (statusMatch) {
              send({ type: "status", text: statusMatch[1] });
            } else {
              send({ type: "text", text: buffer.trim() });
            }
          }
        }

        if (!doneSent) {
          doneSent = true;
          if (code !== 0 && code !== null) {
            send({ type: "error", text: `Forge exited with code ${code}` });
          } else {
            send({ type: "done" });
          }
        }

        close();
        onClose?.();
      });

      proc.on("error", (err) => {
        clearInterval(keepaliveTimer);
        dlog.error("forge-runner", `spawn error: ${err.message}`);
        send({ type: "error", text: err.message });
        close();
      });
    },

    cancel() {
      closed = true;
      clearInterval(keepaliveTimer);
    },
  });
}
