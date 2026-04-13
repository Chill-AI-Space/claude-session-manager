import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse } from "@/lib/claude-runner";
import { logAction } from "@/lib/db";
import { getComputeNode, resolveNode, proxySSE } from "@/lib/remote-compute";
import { SSE_HEADERS } from "@/lib/claude-runner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message, correlationId, verbose, model, agent, previous_session_id, on_complete_url, reply_to_session_id, delegation_task } = body as {
    path: string;
    message: string;
    correlationId?: string;
    verbose?: boolean;
    model?: string;
    agent?: string;
    previous_session_id?: string;
    on_complete_url?: string;
    reply_to_session_id?: string;
    delegation_task?: string;
  };

  if (!projectPath || !message?.trim()) {
    return Response.json({ error: "path and message required" }, { status: 400 });
  }

  const normalizedAgent =
    agent === undefined || agent === "claude" || agent === "codex" || agent === "forge"
      ? agent
      : null;

  if (normalizedAgent === null) {
    return Response.json({ error: `invalid agent: ${String(agent)}` }, { status: 400 });
  }

  // Check if a specific node was requested, or use default compute node
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId) || getComputeNode();

  if (node) {
    // Route to remote VM
    logAction("service", "remote_session_start", JSON.stringify({ node: node.name, path: projectPath }));
    try {
      const stream = await proxySSE(node, "/api/sessions/start", {
        path: projectPath,
        message: message.trim(),
        correlationId,
        verbose: verbose ?? false,
        agent: normalizedAgent ?? undefined,
        model,
      });
      return new Response(stream, { headers: SSE_HEADERS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote start failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
  if (correlationId) {
    logAction("service", "session_start_api_received", JSON.stringify({ correlationId, path: projectPath }));
  }

  if (normalizedAgent === "forge") {
    const stream = getOrchestrator().startForge(projectPath, message.trim(), model);
    return sseResponse(stream);
  }

  if (normalizedAgent === "codex") {
    // Codex is a TUI — open in terminal, then poll for the new thread and return its ID
    const { getCodexPath } = await import("@/lib/codex-bin");
    const { openInTerminal } = await import("@/lib/terminal-launcher");
    const { listCodexThreads } = await import("@/lib/codex-db");
    const { getSetting, getDb } = await import("@/lib/db");
    const bin = getCodexPath();
    const codexSkipFlag = getSetting("dangerously_skip_permissions") === "true" ? " --dangerously-bypass-approvals-and-sandbox" : "";
    const modelFlag = model ? ` -c model="${model}"` : "";

    // Codex has no --append-system-prompt, so inject Session Manager context + delegation contract into the message itself
    const base = "http://localhost:3000";
    let fullMessage = message.trim();

    // Always inject Session Manager context so Codex knows what's available
    fullMessage += [
      "",
      "",
      "[Session Manager Context]",
      `You are running inside Session Manager. You are automatically registered and tracked.`,
      `Find your session ID:`,
      `  curl -s "http://localhost:3000/api/sessions/peers?path=$(pwd)" | python3 -c "import json,sys; peers=json.load(sys.stdin).get('peers',[]); print(peers[0]['session_id'] if peers else 'not found')"`,
      ``,
      `Available tools:`,
      `  Spawn sub-session:  POST http://localhost:3000/api/sessions/start`,
      `    body: {"path":"REPO_ROOT","message":"...","agent":"codex"|"claude","reply_to_session_id":"YOUR_ID","delegation_task":"..."}`,
      `    ALWAYS use -N flag: CHILD=$(curl -s -N -X POST ... | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\\([^"]*\\)".*/\\1/')`,
      `  Set alarm:          POST http://localhost:3000/api/sessions/YOUR_ID/alarm`,
      `    body: {"message":"what to do if I die","check_after_ms":180000}`,
      `  Cancel alarm:       DELETE http://localhost:3000/api/sessions/YOUR_ID/alarm`,
      `  Active sessions:    GET http://localhost:3000/api/sessions`,
      ``,
      `Full delegation guide: /Users/vova/Documents/GitHub/claude-session-manager/docs/delegation-guide.md`,
      "[End Session Manager Context]",
    ].join("\n");

    if (reply_to_session_id) {
      fullMessage += [
        "",
        "",
        "[Delegation Contract]",
        `You were spawned to handle a delegated task${delegation_task ? `: "${delegation_task}"` : ""}.`,
        `Before reporting back, persist your work: code → commit to branch; plans/findings → save to dated file (docs/YYYY-MM-DD-name.md) and commit. Nothing in session context only — if not in git, it will be lost.`,
        `If you spawn sub-sessions, ALWAYS specify "agent" explicitly: "agent":"codex" for code, "agent":"claude" for review/analysis. Never omit "agent" — default is "claude" which is WRONG for code tasks.`,
        `CRITICAL: use -N (no-buffer) with curl and capture session_id: CHILD_ID=$(curl -s -N -X POST ".../start" ... | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\\([^"]*\\)".*/\\1/'). If CHILD_ID empty — spawn failed, retry.`,
        `When done, report back by running ONE of these:`,
        `  curl -s -X POST "${base}/api/sessions/${reply_to_session_id}/reply" -H "Content-Type: application/json" -d '{"message": "DONE: <summary> | committed: <branch>"}'`,
        `  curl -s -X POST "${base}/api/sessions/${reply_to_session_id}/reply" -H "Content-Type: application/json" -d '{"message": "FAILED: <reason> | partial work committed: <yes/no>"}'`,
        `Do NOT finish without calling one of these AND committing your work.`,
        "[End Delegation Contract]",
      ].join("\n");
    }

    // Use ANSI-C quoting $'...' so newlines, quotes, and other special chars are safe.
    // Plain double-quote escaping breaks when the message contains literal newlines —
    // the shell enters `dquote>` mode waiting for the closing quote.
    const ansiQuote = (s: string) =>
      "$'" +
      s
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/"/g, '\\"') +
      "'";
    const shellCmd = `cd "${projectPath}" && "${bin}"${codexSkipFlag}${modelFlag} ${ansiQuote(fullMessage)}`;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Snapshot existing thread IDs before launch
          const existingIds = new Set(listCodexThreads().map((t) => t.id));
          const startedAt = Math.floor(Date.now() / 1000) - 5; // 5s tolerance

          const { terminal } = await openInTerminal(shellCmd);
          controller.enqueue(`data: ${JSON.stringify({ type: "status", status: `Codex opened in ${terminal}` })}\n\n`);

          // Poll for the new Codex thread (up to 45 seconds)
          let sessionId: string | null = null;
          for (let i = 0; i < 90; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const threads = listCodexThreads();
            // Rely on snapshot exclusion alone — created_at filter can misfire due to clock skew
            const newThread = threads.find((t) => !existingIds.has(t.id) && t.rollout_path);
            if (newThread) {
              // Wait a bit more if first_user_message isn't populated yet
              // (Codex may create the thread before recording the first prompt)
              if (!newThread.first_user_message && i < 80) {
                await new Promise((r) => setTimeout(r, 300));
                const refreshed = listCodexThreads().find((t) => t.id === newThread.id);
                if (refreshed?.first_user_message) Object.assign(newThread, refreshed);
              }
              sessionId = newThread.id;
              const fsLib = await import("fs");
              const osLib = await import("os");
              const db = getDb();
              const cwd = newThread.cwd ?? osLib.default.homedir();
              const projectDir = cwd.replace(/[\\/]/g, "-");
              const modelLabel = newThread.model ?? (newThread.model_provider === "openai" ? "gpt-4o" : newThread.model_provider);
              let fileMtime = newThread.updated_at * 1000;
              try { fileMtime = fsLib.statSync(newThread.rollout_path).mtimeMs; } catch { /* use DB timestamp */ }
              const now = new Date().toISOString();
              db.prepare(`
                INSERT INTO sessions (
                  session_id, jsonl_path, project_dir, project_path,
                  git_branch, claude_version, model, agent_type,
                  first_prompt, last_message, last_message_role, has_result,
                  message_count, total_input_tokens, total_output_tokens,
                  created_at, modified_at, file_mtime, file_size, last_scanned_at,
                  reply_to_session_id, delegation_task, delegation_status
                ) VALUES (
                  @session_id, @jsonl_path, @project_dir, @project_path,
                  @git_branch, NULL, @model, 'codex',
                  @first_prompt, @last_message, NULL, 1,
                  0, @total_input_tokens, 0,
                  @created_at, @modified_at, @file_mtime, 0, @last_scanned_at,
                  @reply_to_session_id, @delegation_task, @delegation_status
                ) ON CONFLICT(session_id) DO UPDATE SET
                  jsonl_path = @jsonl_path, model = @model,
                  modified_at = @modified_at, file_mtime = @file_mtime,
                  last_scanned_at = @last_scanned_at
              `).run({
                session_id: sessionId,
                jsonl_path: newThread.rollout_path,
                project_dir: projectDir,
                project_path: cwd,
                git_branch: newThread.git_branch ?? null,
                model: modelLabel,
                first_prompt: message.trim().slice(0, 1000),
                last_message: message.trim().slice(-1000),
                total_input_tokens: newThread.tokens_used ?? 0,
                created_at: new Date(newThread.created_at * 1000).toISOString(),
                modified_at: new Date(fileMtime).toISOString(),
                file_mtime: fileMtime,
                last_scanned_at: now,
                reply_to_session_id: reply_to_session_id ?? null,
                delegation_task: delegation_task ?? null,
                delegation_status: reply_to_session_id ? "pending" : null,
              });
              controller.enqueue(`data: ${JSON.stringify({ type: "session_id", session_id: sessionId })}\n\n`);
              break;
            }
          }
          if (!sessionId) {
            controller.enqueue(`data: ${JSON.stringify({ type: "status", status: "Codex started — check sidebar for new session" })}\n\n`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
        }
        controller.enqueue(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Default to Claude unless another agent is explicitly requested.
  const stream = getOrchestrator().start(projectPath, message.trim(), correlationId, verbose ?? false, model, previous_session_id, on_complete_url, reply_to_session_id, delegation_task);
  return sseResponse(stream);
}
