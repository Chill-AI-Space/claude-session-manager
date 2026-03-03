import { NextRequest } from "next/server";
import { getDb, getSetting } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { spawn } from "child_process";
import { killSessionProcesses } from "@/lib/process-detector";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();
  const message = body.message;

  if (!message || typeof message !== "string") {
    return new Response(
      JSON.stringify({ error: "Message is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return new Response(
      JSON.stringify({ error: "Session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // Auto-kill terminal sessions if setting is enabled
  const autoKill = getSetting("auto_kill_terminal_on_reply") === "true";
  if (autoKill) {
    killSessionProcesses(sessionId);
    // Brief pause for process cleanup
    await new Promise((r) => setTimeout(r, 500));
  }

  // Build clean env without Claude Code vars
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE")) delete env[key];
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
      const args = [
        "--resume",
        sessionId,
        "-p",
        message,
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }

      const proc = spawn(
        "claude",
        args,
        {
          cwd: session.project_path,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      // Close stdin to prevent hanging on permission prompts
      proc.stdin.end();

      let buffer = "";

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);

            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "text", text: block.text })}\n\n`
                    )
                  );
                }
              }
            } else if (obj.type === "result") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "done",
                    result: obj.result,
                    is_error: obj.is_error,
                    cost: obj.total_cost_usd,
                  })}\n\n`
                )
              );
            }
          } catch {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "chunk", text: line })}\n\n`
              )
            );
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", text })}\n\n`
          )
        );
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer);
            if (obj.type === "result") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "done",
                    result: obj.result,
                    is_error: obj.is_error,
                    cost: obj.total_cost_usd,
                  })}\n\n`
                )
              );
            }
          } catch {
            // ignore
          }
        }

        if (code !== 0 && code !== null) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", text: `Process exited with code ${code}` })}\n\n`
            )
          );
        }
        controller.close();
      });

      proc.on("error", (err) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`
          )
        );
        controller.close();
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
