import { NextRequest } from "next/server";
import { getDb, getSetting, logAction } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { killSessionProcesses } from "@/lib/process-detector";
import { createSSEStream, sseResponse } from "@/lib/claude-runner";
import { getCleanEnv } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();
  const message = body.message;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  logAction("service", "reply", `msg_len:${message.length}`, sessionId);

  const finalMessage = message;

  // Auto-kill terminal sessions if setting is enabled
  const autoKill = getSetting("auto_kill_terminal_on_reply") === "true";
  if (autoKill) {
    killSessionProcesses(sessionId);
    // Brief pause for process cleanup
    await new Promise((r) => setTimeout(r, 500));
  }

  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const maxTurns = getSetting("max_turns") || "80";
  const effort = getSetting("effort_level") || "high";
  const args = [
    "--resume", sessionId,
    "-p", finalMessage,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", maxTurns,
    "--effort", effort,
  ];
  if (skipPermissions) args.push("--dangerously-skip-permissions");

  const stream = createSSEStream({
    args,
    cwd: session.project_path,
    onLine(obj, send) {
      if (obj.type === "assistant" && obj.message) {
        const msg = obj.message as { content?: Array<{ type: string; text?: string; name?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              send({ type: "text", text: block.text });
            } else if (block.type === "tool_use") {
              send({ type: "status", text: `Using tool: ${block.name}` });
            }
          }
        }
      } else if (obj.type === "result") {
        send({
          type: "done",
          result: obj.result,
          is_error: obj.is_error,
          cost: obj.total_cost_usd,
        });
      }
    },
    // No onProc abort handler — Claude runs detached so it survives
    // browser tab close / SSE disconnect. Results go to JSONL regardless.
  });

  return sseResponse(stream);
}
