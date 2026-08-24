import { NextRequest } from "next/server";
import os from "os";
import path from "path";
import { stat } from "fs/promises";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse } from "@/lib/claude-runner";
import { getSetting, logAction } from "@/lib/db";
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

  const defaultAgentSetting = getSetting("default_agent");
  const defaultAgent =
    defaultAgentSetting === "claude" || defaultAgentSetting === "codex" || defaultAgentSetting === "forge"
      ? defaultAgentSetting
      : "codex";

  const normalizedAgent =
    agent === undefined
      ? defaultAgent
      : agent === "claude" || agent === "codex" || agent === "forge"
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

  const resolvedProjectPath = path.resolve(projectPath);
  if (!resolvedProjectPath.startsWith(os.homedir())) {
    return Response.json({ error: "Path must be within home directory" }, { status: 403 });
  }

  try {
    const s = await stat(resolvedProjectPath);
    if (!s.isDirectory()) {
      return Response.json({ error: "Path is not a directory" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Path does not exist" }, { status: 404 });
  }

  if (normalizedAgent === "forge") {
    const stream = getOrchestrator().startForge(resolvedProjectPath, message.trim(), model);
    return sseResponse(stream);
  }

  if (normalizedAgent === "codex") {
    // Codex is a TUI — open in terminal, then poll for the new thread and return its ID
    const { getCodexPath } = await import("@/lib/codex-bin");
    const { buildCodexStartShellCommand } = await import("@/lib/codex-command");
    const { openInTerminal } = await import("@/lib/terminal-launcher");
    const { listCodexThreads } = await import("@/lib/codex-db");
    const { getDb } = await import("@/lib/db");
    const bin = getCodexPath();
    const skipPermissions = getSetting("dangerously_skip_permissions") === "true";

    // Codex has no --append-system-prompt, so inject delegation contract into the message itself
    let fullMessage = message.trim();

    if (reply_to_session_id) {
      const base = "http://localhost:3000";
      fullMessage += [
        "",
        "",
        "[Delegation Contract]",
        `You were spawned to handle a delegated task${delegation_task ? `: "${delegation_task}"` : ""}.`,
        `Before reporting back, persist your work: code → commit to branch; plans/findings → save to dated file (docs/YYYY-MM-DD-name.md) and commit. Nothing in session context only — if not in git, it will be lost.`,
        `If you spawn sub-sessions, ALWAYS specify "agent" explicitly: "agent":"codex" for code, "agent":"claude" for review/analysis. Never omit "agent" — the default agent may be wrong for the task.`,
        `CRITICAL: use -N (no-buffer) with curl and capture session_id: CHILD_ID=$(curl -s -N -X POST ".../start" ... | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\\([^"]*\\)".*/\\1/'). If CHILD_ID empty — spawn failed, retry.`,
        `When done, report back by running ONE of these:`,
        `  curl -s -X POST "${base}/api/sessions/${reply_to_session_id}/reply" -H "Content-Type: application/json" -d '{"message": "DONE: <summary> | committed: <branch>"}'`,
        `  curl -s -X POST "${base}/api/sessions/${reply_to_session_id}/reply" -H "Content-Type: application/json" -d '{"message": "FAILED: <reason> | partial work committed: <yes/no>"}'`,
        `Do NOT finish without calling one of these AND committing your work.`,
        "[End Delegation Contract]",
      ].join("\n");
    }

    const shellCmd = buildCodexStartShellCommand({
      projectPath: resolvedProjectPath,
      bin,
      message: fullMessage,
      skipPermissions,
      model,
    });
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Snapshot existing thread IDs before launch
          const existingIds = new Set(listCodexThreads().map((t) => t.id));
          const { terminal } = await openInTerminal(shellCmd, { cwd: resolvedProjectPath });
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
              const db = getDb();
              const cwd = resolvedProjectPath;
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

  // At this point, only Claude remains: codex/forge were handled above.
  //
  // Open in a real interactive terminal instead of the headless orch.start()
  // SSE stream, EXCEPT when this is a programmatic/automated spawn (a
  // delegated sub-agent, a context-carryover "new session", or one that
  // wants a completion webhook) — those are autonomous background workers
  // with no user watching, and orch.start()'s DB bookkeeping (delegation
  // linkage, previous_session_id, onCompleteUrl) only exists on that path.
  // Headless sessions run with fully-piped stdio and no pty — fine for
  // streaming output into the browser, but the Chrome extension only pairs
  // with a real terminal-attached process, not a piped one, which is what
  // a manually-started interactive session needs.
  const isAutomatedSpawn = Boolean(previous_session_id || on_complete_url || reply_to_session_id);

  if (!isAutomatedSpawn) {
    const { buildStartShellCommand } = await import("@/lib/session-terminal");
    const { openInTerminal } = await import("@/lib/terminal-launcher");
    const { claudeProjectsDir } = await import("@/lib/utils");
    const fsLib = await import("fs");
    const { scanSessions } = await import("@/lib/scanner");
    const { buildSessionContextPrompt } = await import("@/lib/orchestrator");

    const projectDirName = resolvedProjectPath.replace(/[\\/]/g, "-");
    const sessionsDir = path.join(claudeProjectsDir(), projectDirName);
    let existingIds = new Set<string>();
    try {
      existingIds = new Set(
        fsLib.readdirSync(sessionsDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => f.replace(/\.jsonl$/, ""))
      );
    } catch {
      // Directory doesn't exist yet — this is the first session in this project.
    }

    const shellCmd = buildStartShellCommand(resolvedProjectPath, message.trim(), model, buildSessionContextPrompt());
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const { terminal } = await openInTerminal(shellCmd, { cwd: resolvedProjectPath });
          send({ type: "status", text: `Opened in ${terminal}` });

          let sessionId: string | null = null;
          for (let i = 0; i < 90; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              const files = fsLib.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
              const newFile = files.find((f) => !existingIds.has(f.replace(/\.jsonl$/, "")));
              if (newFile) {
                sessionId = newFile.replace(/\.jsonl$/, "");
                break;
              }
            } catch {
              // Directory may not exist for the first ~1s after launch.
            }
          }

          if (sessionId) {
            try { await scanSessions("incremental"); } catch { /* non-critical — sidebar will pick it up regardless */ }
            send({ type: "session_id", session_id: sessionId });
          } else {
            send({ type: "status", text: "Claude started — check sidebar for new session" });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: "error", error: msg });
        }

        send({ type: "done" });
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Automated/programmatic spawn — headless, so the caller's curl/orchestrator
  // gets an SSE stream to parse, with delegation linkage + completion webhook
  // bookkeeping intact.
  const stream = getOrchestrator().start(resolvedProjectPath, message.trim(), correlationId, verbose ?? false, model, previous_session_id, on_complete_url, reply_to_session_id, delegation_task);
  return sseResponse(stream);
}
