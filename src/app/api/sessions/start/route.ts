import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getCleanEnv } from "@/lib/utils";
import { getSetting, logAction } from "@/lib/db";
import { scanSessions } from "@/lib/scanner";
import { generateTitleBatch } from "@/lib/title-generator";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message } = body as { path: string; message: string };

  if (!projectPath || !message?.trim()) {
    return new Response(JSON.stringify({ error: "path and message required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const env = getCleanEnv();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch { /* already closed */ }
      };

      const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
      const effort = getSetting("effort_level") || "high";
      const args = [
        "-p",
        message.trim(),
        "--output-format",
        "stream-json",
        "--verbose",
        "--effort",
        effort,
      ];
      if (skipPermissions) args.push("--dangerously-skip-permissions");

      const proc = spawn("claude", args, {
        cwd: projectPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let sessionId: string | null = null;
      let buffer = "";

      proc.stdout!.on("data", (data: Buffer) => {
        if (closed) return;
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);

            // Extract session ID from first event (stream-json uses snake_case)
            if (!sessionId && (obj.session_id || obj.sessionId)) {
              sessionId = obj.session_id ?? obj.sessionId;
              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "session_id", session_id: sessionId })}\n\n`
                )
              );
              logAction("service", "start_web_session", projectPath, sessionId ?? undefined);
            }

            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  safeEnqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "text", text: block.text })}\n\n`
                    )
                  );
                }
              }
            } else if (obj.type === "result") {
              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "done",
                    result: obj.result,
                    is_error: obj.is_error,
                  })}\n\n`
                )
              );
            }
          } catch {
            // skip non-JSON lines
          }
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString();
        safeEnqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", text })}\n\n`)
        );
      });

      proc.on("close", async () => {
        // Index the new session in DB, then generate title
        try {
          await scanSessions("incremental");
          generateTitleBatch(1).catch(() => {});
        } catch { /* non-critical */ }
        safeClose();
      });

      proc.on("error", (err) => {
        safeEnqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`)
        );
        safeClose();
      });

      // Kill child process if client disconnects
      request.signal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        safeClose();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
