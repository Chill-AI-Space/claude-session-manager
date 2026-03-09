import { NextRequest } from "next/server";
import { getDb, getSetting, logAction, getContextSourceGroups } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { spawn, ChildProcess } from "child_process";
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

  logAction("service", "reply", `msg_len:${message.length}`, sessionId);

  // Determine if this message warrants context injection
  const { messageNeedsContext, getTeamHubContext, formatContextBlock } = await import("@/lib/teamhub");
  const needsContext = messageNeedsContext(message);

  let finalMessage = message;
  const teamhubEnabled = getSetting("teamhub_enabled") !== "false"; // default: auto
  if (needsContext && teamhubEnabled && session.project_path) {
    try {
      const ctx = await getTeamHubContext(session.project_path, message);
      if (ctx) {
        const block = formatContextBlock(ctx);
        finalMessage = block + message;
        logAction(
          "service",
          "teamhub_inject",
          `hub:${ctx.hubName} ~${ctx.tokenEstimate}tok`,
          sessionId,
          block
        );
      }
    } catch { /* teamhub unavailable — continue without context */ }
  }

  // Context Sources injection
  if (needsContext && session.project_path) {
    try {
      const groups = getContextSourceGroups();
      if (groups.length > 0) {
        const { getContextForProject, formatContextBlock } = await import("@/lib/context-fetcher");
        const contextResults = await getContextForProject(session.project_path, groups);
        for (const { groupName, content, tokenEstimate } of contextResults) {
          finalMessage = formatContextBlock(groupName, content) + finalMessage;
          logAction(
            "service",
            "context_source_inject",
            `group:${groupName} ~${tokenEstimate}tok`,
            sessionId
          );
        }
      }
    } catch { /* non-critical */ }
  }

  // Auto-kill terminal sessions if setting is enabled
  const autoKill = getSetting("auto_kill_terminal_on_reply") === "true";
  if (autoKill) {
    killSessionProcesses(sessionId);
    // Brief pause for process cleanup
    await new Promise((r) => setTimeout(r, 500));
  }

  const { getCleanEnv } = await import("@/lib/utils");
  const env = getCleanEnv();

  const encoder = new TextEncoder();
  let proc: ChildProcess;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      function send(chunk: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      }

      function close() {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
      const maxTurns = getSetting("max_turns") || "80";
      const effort = getSetting("effort_level") || "high";
      const args = [
        "--resume",
        sessionId,
        "-p",
        finalMessage,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        maxTurns,
        "--effort",
        effort,
      ];
      if (skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }

      proc = spawn(
        "claude",
        args,
        {
          cwd: session.project_path,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        }
      );

      // Keepalive: send a ping every 15s so the SSE connection doesn't die
      // during long tool-use cycles where no text is produced
      const keepalive = setInterval(() => {
        if (closed) {
          clearInterval(keepalive);
          return;
        }
        send(`: keepalive\n\n`);
      }, 15_000);

      let buffer = "";

      proc.stdout!.on("data", (data: Buffer) => {
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
                  send(`data: ${JSON.stringify({ type: "text", text: block.text })}\n\n`);
                } else if (block.type === "tool_use") {
                  send(`data: ${JSON.stringify({ type: "status", text: `Using tool: ${block.name}` })}\n\n`);
                }
              }
            } else if (obj.type === "result") {
              send(`data: ${JSON.stringify({
                type: "done",
                result: obj.result,
                is_error: obj.is_error,
                cost: obj.total_cost_usd,
              })}\n\n`);
            }
          } catch {
            send(`data: ${JSON.stringify({ type: "chunk", text: line })}\n\n`);
          }
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString();
        send(`data: ${JSON.stringify({ type: "error", text })}\n\n`);
      });

      proc.on("close", (code) => {
        clearInterval(keepalive);

        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer);
            if (obj.type === "result") {
              send(`data: ${JSON.stringify({
                type: "done",
                result: obj.result,
                is_error: obj.is_error,
                cost: obj.total_cost_usd,
              })}\n\n`);
            }
          } catch {
            // ignore
          }
        }

        if (code !== 0 && code !== null) {
          send(`data: ${JSON.stringify({ type: "error", text: `Process exited with code ${code}` })}\n\n`);
        }
        close();
      });

      proc.on("error", (err) => {
        clearInterval(keepalive);
        send(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`);
        close();
      });
    },
    cancel() {
      // Client disconnected — kill the subprocess
      try {
        proc?.kill("SIGTERM");
      } catch {
        // already dead
      }
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
