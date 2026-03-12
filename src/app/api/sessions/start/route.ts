import { NextRequest } from "next/server";
import { getSetting, logAction } from "@/lib/db";
import { scanSessions } from "@/lib/scanner";
import { generateTitleBatch } from "@/lib/title-generator";
import { createSSEStream, sseResponse } from "@/lib/claude-runner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message } = body as { path: string; message: string };

  if (!projectPath || !message?.trim()) {
    return Response.json({ error: "path and message required" }, { status: 400 });
  }

  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const effort = getSetting("effort_level") || "high";
  const args = [
    "-p", message.trim(),
    "--output-format", "stream-json",
    "--verbose",
    "--effort", effort,
  ];
  if (skipPermissions) args.push("--dangerously-skip-permissions");

  let sessionId: string | null = null;

  const stream = createSSEStream({
    args,
    cwd: projectPath,
    onLine(obj, send) {
      // Extract session ID from first event
      if (!sessionId && (obj.session_id || obj.sessionId)) {
        sessionId = (obj.session_id ?? obj.sessionId) as string;
        send({ type: "session_id", session_id: sessionId });
        logAction("service", "start_web_session", projectPath, sessionId ?? undefined);
      }

      if (obj.type === "assistant" && obj.message) {
        const msg = obj.message as { content?: Array<{ type: string; text?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              send({ type: "text", text: block.text });
            }
          }
        }
      } else if (obj.type === "result") {
        send({
          type: "done",
          result: obj.result,
          is_error: obj.is_error,
        });
      }
    },
    async onClose() {
      // Index the new session in DB, then generate title
      try {
        await scanSessions("incremental");
        generateTitleBatch(1).catch(() => {});
      } catch { /* non-critical */ }
    },
    onProc(proc) {
      request.signal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    },
  });

  return sseResponse(stream);
}
