import { getDb, indexSessionContent, logAction, getSetting } from "./db";
import { glob } from "glob";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getCleanEnv, claudeProjectsDir, UUID_RE } from "./utils";
import { getClaudePath } from "./claude-bin";
import { openInTerminal } from "./terminal-launcher";
import type { SessionRow } from "./types";

// ── Server-side auto-retry ────────────────────────────────────────────────────

/** Session IDs with a pending server-side retry — prevents double-scheduling. */
const retryScheduled = new Set<string>();

// ── Server-side stall detection + auto-continue ───────────────────────────────

/** Session IDs already scheduled for stall-continue — prevents double-scheduling. */
const stallScheduled = new Set<string>();

/**
 * How long (ms) a session must be silent (no JSONL writes) while active
 * before we consider it "stalled" and potentially auto-continue it.
 */
const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ask a small LLM (claude-haiku-4-5) whether the last assistant message
 * is asking the user for clarification/input.
 * Returns true = Claude is waiting for user, false = Claude just stopped mid-task.
 */
async function isWaitingForUser(lastAssistantText: string): Promise<boolean> {
  if (!lastAssistantText.trim()) return false;

  // Cheap heuristic first — avoid API call when obvious
  const lower = lastAssistantText.toLowerCase();
  const waitingPatterns = [
    /\?\s*$/, // ends with question mark
    /which (option|approach|do you|would you)/,
    /do you want/,
    /should i (proceed|continue|go ahead)/,
    /let me know/,
    /please (confirm|clarify|specify|choose|select|provide)/,
    /what (would|do) you (like|prefer|want)/,
    /готов|подтверди|выбери|какой вариант|хотите|скажи/,
  ];
  const looksLikeQuestion = waitingPatterns.some((re) => re.test(lower));

  // If clearly asking a question, trust the heuristic — no API call needed
  if (looksLikeQuestion) return true;

  // For ambiguous cases: call Haiku to classify
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return false;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{
          role: "user",
          content: `Is this message asking the user for clarification, confirmation, or a decision before proceeding? Answer only YES or NO.\n\nMessage:\n${lastAssistantText.slice(0, 1500)}`,
        }],
      }),
    });

    if (!response.ok) return false;
    const json = await response.json();
    const answer = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
    return answer.startsWith("YES");
  } catch {
    return false; // default: assume not waiting, safe to continue
  }
}

/**
 * Send "continue" to a stalled session if Claude is not waiting for user input.
 */
async function serverAutoContinue(sessionId: string): Promise<void> {
  const db = getDb();
  const session = db
    .prepare("SELECT project_path, last_message_role, last_message, jsonl_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "project_path" | "last_message_role" | "jsonl_path"> & { last_message: string | null } | undefined;

  if (!session) return;
  if (getSetting("auto_continue_on_stall") !== "true") return;

  // Re-check: session must still be active (process still running) with assistant as last message
  const { isSessionActive } = await import("./process-detector");
  if (!isSessionActive(sessionId)) return;

  // Re-check mtime — if it changed, session is no longer stalled
  try {
    const mtime = fs.statSync(session.jsonl_path).mtimeMs;
    if (Date.now() - mtime < STALL_THRESHOLD_MS) return;
  } catch {
    return;
  }

  if (session.last_message_role !== "assistant") return;

  // Get last assistant text from JSONL for LLM classification
  const lastAssistantText = extractLastAssistantText(session.jsonl_path);
  const waiting = await isWaitingForUser(lastAssistantText);

  if (waiting) {
    logAction("service", "stall_continue_skipped", "Claude is asking user a question", sessionId);
    return;
  }

  logAction("service", "stall_continue_fired", `stalled >${STALL_THRESHOLD_MS / 60_000}min`, sessionId);

  const context = session.last_message
    ? `\n\nFor context, the user's last message was: "${session.last_message.slice(0, 200)}"`
    : "";
  const stallPrompt = `You appear to have stalled — no output for over 5 minutes. I noticed and auto-resumed you. Please check what you were doing and continue the task.${context}`;

  const proc = spawn(
    getClaudePath(),
    ["--resume", sessionId, "-p", stallPrompt, "--output-format", "stream-json", "--verbose"],
    { cwd: session.project_path, env: getCleanEnv(), stdio: ["ignore", "pipe", "pipe"] }
  );
  proc.stdout?.resume();
  proc.stderr?.resume();
  proc.on("close", (code) => {
    logAction("service", code === 0 ? "stall_continue_done" : "stall_continue_failed", `exit:${code}`, sessionId);
  });
}

function scheduleStallContinue(sessionId: string, delayMs = 60_000): void {
  if (stallScheduled.has(sessionId)) return;
  stallScheduled.add(sessionId);
  setTimeout(async () => {
    stallScheduled.delete(sessionId);
    await serverAutoContinue(sessionId);
  }, delayMs);
}

/** Extract the last assistant text block from a JSONL file for LLM classification.
 *  Reads only the tail of the file (64 KB) to avoid loading multi-MB files. */
function extractLastAssistantText(jsonlPath: string): string {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 64 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    // If we started mid-file, first line is likely truncated — skip it
    if (start > 0) lines.shift();
    lines.reverse();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message?.content) continue;
        const content = obj.message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { text: string }) => b.text)
            .join("\n");
          if (text.trim()) return text;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * Spawn `claude --resume {id}` in the background with a helpful crash-recovery prompt.
 * Called automatically 30s after a crash is detected during scanning.
 */
function serverAutoRetry(sessionId: string): void {
  const db = getDb();
  const session = db
    .prepare("SELECT project_path, last_message_role, last_message FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "project_path" | "last_message_role"> & { last_message: string | null } | undefined;

  // Bail if session recovered on its own or setting was disabled
  if (!session || session.last_message_role !== "tool_result") return;
  if (getSetting("auto_retry_on_crash") === "false") return;

  logAction("service", "auto_retry_fired", "server-side 30s timeout", sessionId);

  const context = session.last_message
    ? `\n\nFor context, the user's last message was: "${session.last_message.slice(0, 200)}"`
    : "";
  const retryPrompt = `You crashed mid-tool-execution. I noticed and auto-resumed you. Please check what you were doing, pick up where you left off, and continue the task.${context}`;

  const proc = spawn(
    getClaudePath(),
    ["--resume", sessionId, "-p", retryPrompt, "--output-format", "stream-json", "--verbose"],
    { cwd: session.project_path, env: getCleanEnv(), stdio: ["ignore", "pipe", "pipe"] }
  );

  // Drain stdout/stderr so buffers don't block the process
  proc.stdout?.resume();
  proc.stderr?.resume();

  proc.on("close", (code) => {
    logAction(
      "service",
      code === 0 ? "auto_retry_done" : "auto_retry_failed",
      `exit:${code}`,
      sessionId
    );
  });
}

function scheduleServerAutoRetry(sessionId: string, delayMs = 30_000): void {
  if (retryScheduled.has(sessionId)) return; // already queued
  retryScheduled.add(sessionId);
  setTimeout(() => {
    retryScheduled.delete(sessionId);
    serverAutoRetry(sessionId);
  }, delayMs);
}

// ── Permission escalation — push stuck sessions to terminal ──────────────────

/** Session IDs already escalated to terminal — prevents double-escalation. */
const escalationScheduled = new Set<string>();

/**
 * Permission-denied patterns in tool_result content or assistant text.
 * When Claude hits these repeatedly it means the web-spawned process
 * lacks permissions that a terminal session with --dangerously-skip-permissions would have.
 */
const PERMISSION_PATTERNS = [
  /permission denied/i,
  /operation not permitted/i,
  /EACCES/,
  /access denied/i,
  /not authorized/i,
  /sandbox.*restrict/i,
  /cannot (write|read|access|create|delete|modify)/i,
  /unable to (write|read|access|create|delete)/i,
  /read-only file system/i,
];

/**
 * Check the tail of a JSONL file for permission-denied patterns.
 * Looks at the last N tool_result blocks and assistant messages.
 * Returns true if 2+ distinct permission errors are found (= stuck in a loop).
 */
function detectPermissionLoop(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 128 * 1024; // last 128KB
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    if (start > 0) lines.shift(); // skip partial first line

    let permissionHits = 0;

    // Check last 30 lines for permission patterns
    const recentLines = lines.slice(-30);
    for (const line of recentLines) {
      try {
        const obj = JSON.parse(line);

        // Check tool_result content for permission errors
        if (obj.type === "user" && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block.type === "tool_result") {
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((b: { text?: string }) => b.text || "").join(" ")
                  : "";
              if (PERMISSION_PATTERNS.some((re) => re.test(text))) {
                permissionHits++;
              }
            }
          }
        }

        // Check assistant text asking about permissions
        if (obj.type === "assistant" && obj.message?.content) {
          const content = obj.message.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")
              : "";
          if (PERMISSION_PATTERNS.some((re) => re.test(text))) {
            permissionHits++;
          }
        }
      } catch { /* skip malformed */ }
    }

    return permissionHits >= 2;
  } catch {
    return false;
  }
}

/**
 * Escalate a permission-stuck session to a terminal window.
 * Opens iTerm2/Terminal with `claude --resume --dangerously-skip-permissions`
 * and sends "check access again please" as the prompt.
 */
async function escalateToTerminal(sessionId: string): Promise<void> {
  const db = getDb();
  const session = db
    .prepare("SELECT project_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as { project_path: string } | undefined;

  if (!session) return;
  if (getSetting("auto_retry_on_crash") === "false") return;

  logAction("service", "permission_escalation_fired", "pushing to terminal with --dangerously-skip-permissions", sessionId);

  const claudePath = getClaudePath();
  const shellCmd = `cd ${JSON.stringify(session.project_path)} && ${claudePath} --resume ${sessionId} --dangerously-skip-permissions -p "check access again please"`;

  try {
    const { terminal } = await openInTerminal(shellCmd);
    logAction("service", "permission_escalation_done", `terminal:${terminal}`, sessionId);
  } catch (err) {
    logAction("service", "permission_escalation_failed", `${err}`, sessionId);
  }
}

function schedulePermissionEscalation(sessionId: string, jsonlPath: string, delayMs = 15_000): void {
  if (escalationScheduled.has(sessionId)) return;
  escalationScheduled.add(sessionId);
  setTimeout(async () => {
    escalationScheduled.delete(sessionId);
    // Re-check: still looks like a permission issue?
    if (detectPermissionLoop(jsonlPath)) {
      await escalateToTerminal(sessionId);
    } else {
      // Not a permission issue after all — fall back to normal retry
      serverAutoRetry(sessionId);
    }
  }, delayMs);
}

const CLAUDE_DIR = claudeProjectsDir();

interface ScanResult {
  sessionsScanned: number;
  sessionsSkipped: number;
  projectsFound: number;
  duration: number;
}

interface JsonlMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch: string | null;
  claudeVersion: string | null;
  model: string | null;
  firstPrompt: string | null;
  lastMessage: string | null;
  lastMessageRole: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  modifiedAt: string;
  fullText: string;
}

function extractMetadataFromJsonl(filePath: string): JsonlMetadata | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    let sessionId = "";
    let projectPath = "";
    let gitBranch: string | null = null;
    let claudeVersion: string | null = null;
    let model: string | null = null;
    let firstPrompt: string | null = null;
    let lastMessage: string | null = null;
    let lastMessageRole: string | null = null;
    let messageCount = 0;
    const textParts: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let createdAt = "";
    let modifiedAt = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        if (obj.type === "user" || obj.type === "assistant") {
          messageCount++;
          // Detect tool_result messages (Claude died mid-execution)
          if (obj.type === "user" && Array.isArray(obj.message?.content) &&
              obj.message.content.every((b: { type: string }) => b.type === "tool_result")) {
            lastMessageRole = "tool_result";
          } else {
            lastMessageRole = obj.type;
          }

          if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
          if (!projectPath && obj.cwd) projectPath = obj.cwd;
          if (!gitBranch && obj.gitBranch && obj.gitBranch !== "HEAD")
            gitBranch = obj.gitBranch;
          if (!claudeVersion && obj.version) claudeVersion = obj.version;

          const ts = obj.timestamp;
          if (ts) {
            if (!createdAt) createdAt = ts;
            modifiedAt = ts;
          }

          if (obj.type === "user") {
            const msg = obj.message;
            if (msg) {
              const text =
                typeof msg.content === "string"
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content
                        .filter(
                          (b: { type: string }) => b.type === "text"
                        )
                        .map((b: { text: string }) => b.text)
                        .join("")
                    : "";
              // Skip task-notification-only messages for lastMessage/firstPrompt
              const isTaskNotif = text.includes("<task-notification>") &&
                text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").trim().length === 0;
              if (
                text &&
                !text.startsWith("{") &&
                !text.startsWith("[Request interrupted") &&
                !isTaskNotif &&
                text.trim().length > 5
              ) {
                if (!firstPrompt) {
                  firstPrompt = text.slice(0, 500);
                }
                // Always update — last one wins
                lastMessage = text.slice(0, 300);
                textParts.push(text);
              }
            }
          }

          if (obj.type === "assistant" && obj.message) {
            if (obj.message.model) model = obj.message.model;
            const usage = obj.message.usage;
            if (usage) {
              totalInputTokens +=
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0);
              totalOutputTokens += usage.output_tokens || 0;
            }
            // Index assistant text too
            const content = obj.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  textParts.push(block.text);
                }
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!sessionId) {
      sessionId = path.basename(filePath, ".jsonl");
    }

    if (!createdAt) {
      const stat = fs.statSync(filePath);
      createdAt = stat.birthtime.toISOString();
      modifiedAt = stat.mtime.toISOString();
    }

    return {
      sessionId,
      projectPath,
      gitBranch,
      claudeVersion,
      model,
      firstPrompt,
      lastMessage,
      lastMessageRole,
      messageCount,
      totalInputTokens,
      totalOutputTokens,
      createdAt,
      modifiedAt,
      fullText: textParts.join("\n"),
    };
  } catch {
    return null;
  }
}

const BATCH_SIZE = 30; // yield to event loop every N files

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function scanSessions(
  mode: "full" | "incremental" = "incremental"
): Promise<ScanResult> {
  const start = Date.now();
  const db = getDb();

  // Use async glob to avoid blocking during file discovery
  const jsonlFiles = await glob("**/*.jsonl", {
    cwd: CLAUDE_DIR,
    absolute: true,
  });

  let sessionsScanned = 0;
  let sessionsSkipped = 0;
  const projectDirs = new Set<string>();

  // Get existing mtimes for incremental scan
  const existingMtimes = new Map<string, number>();
  if (mode === "incremental") {
    const rows = db
      .prepare("SELECT session_id, file_mtime FROM sessions")
      .all() as { session_id: string; file_mtime: number }[];
    for (const row of rows) {
      existingMtimes.set(row.session_id, row.file_mtime);
    }
  }

  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, jsonl_path, project_dir, project_path,
      git_branch, claude_version, model, first_prompt, last_message, last_message_role,
      message_count, total_input_tokens, total_output_tokens,
      created_at, modified_at, file_mtime, file_size, last_scanned_at
    ) VALUES (
      @session_id, @jsonl_path, @project_dir, @project_path,
      @git_branch, @claude_version, @model, @first_prompt, @last_message, @last_message_role,
      @message_count, @total_input_tokens, @total_output_tokens,
      @created_at, @modified_at, @file_mtime, @file_size, @last_scanned_at
    )
    ON CONFLICT(session_id) DO UPDATE SET
      jsonl_path = @jsonl_path,
      project_dir = @project_dir,
      project_path = @project_path,
      git_branch = COALESCE(@git_branch, sessions.git_branch),
      claude_version = COALESCE(@claude_version, sessions.claude_version),
      model = COALESCE(@model, sessions.model),
      first_prompt = COALESCE(@first_prompt, sessions.first_prompt),
      last_message = COALESCE(@last_message, sessions.last_message),
      last_message_role = COALESCE(@last_message_role, sessions.last_message_role),
      message_count = @message_count,
      total_input_tokens = @total_input_tokens,
      total_output_tokens = @total_output_tokens,
      created_at = @created_at,
      modified_at = @modified_at,
      file_mtime = @file_mtime,
      file_size = @file_size,
      last_scanned_at = @last_scanned_at
  `);

  const upsertProject = db.prepare(`
    INSERT INTO projects (project_dir, project_path, display_name, session_count, last_activity)
    VALUES (@project_dir, @project_path, @display_name, @session_count, @last_activity)
    ON CONFLICT(project_dir) DO UPDATE SET
      project_path = COALESCE(@project_path, projects.project_path),
      display_name = COALESCE(projects.custom_name, @display_name),
      session_count = @session_count,
      last_activity = @last_activity
  `);

  // Collect FTS updates to apply after each batch (FTS operations outside transaction)
  const ftsQueue: { sessionId: string; text: string }[] = [];

  // Deferred actions to run after each batch transaction completes
  // (these involve execSync/spawn calls that shouldn't hold the DB write lock)
  const postTxActions: Array<() => void> = [];

  // Pre-process batch: stat files and extract metadata outside the transaction
  interface PreprocessedFile {
    filePath: string;
    sessionId: string;
    stat: fs.Stats;
    metadata: JsonlMetadata;
    dirName: string;
  }

  function preprocessBatch(batch: string[]): PreprocessedFile[] {
    const results: PreprocessedFile[] = [];
    for (const filePath of batch) {
      const sessionId = path.basename(filePath, ".jsonl");
      if (
        !UUID_RE.test(sessionId)
      ) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const fileMtime = stat.mtimeMs;

      if (mode === "incremental" && existingMtimes.has(sessionId)) {
        const existingMtime = existingMtimes.get(sessionId)!;
        if (Math.abs(existingMtime - fileMtime) < 1000) {
          sessionsSkipped++;
          projectDirs.add(path.basename(path.dirname(filePath)));
          continue;
        }
      }

      const metadata = extractMetadataFromJsonl(filePath);
      if (!metadata) continue;

      // Skip internal utility sessions
      if (metadata.firstPrompt?.startsWith("Generate a short descriptive title")) {
        results.push({ filePath, sessionId, stat, metadata, dirName: path.basename(path.dirname(filePath)) });
        continue;
      }

      results.push({
        filePath,
        sessionId,
        stat,
        metadata,
        dirName: path.basename(path.dirname(filePath)),
      });
    }
    return results;
  }

  // DB-only transaction: no I/O, no execSync, no spawn
  const insertBatch = db.transaction((items: PreprocessedFile[]) => {
    for (const { filePath, sessionId, stat, metadata, dirName } of items) {
      // Handle utility sessions — delete from DB
      if (metadata.firstPrompt?.startsWith("Generate a short descriptive title")) {
        db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
        continue;
      }

      projectDirs.add(dirName);

      // Detect newly-crashed sessions
      if (metadata.lastMessageRole === "tool_result") {
        const prev = db
          .prepare("SELECT last_message_role FROM sessions WHERE session_id = ?")
          .get(sessionId) as { last_message_role: string | null } | undefined;
        if (prev?.last_message_role !== "tool_result") {
          logAction("service", "crash_detected", `jsonl:${filePath}`, sessionId);
          const capturedPath = filePath;
          postTxActions.push(() => {
            // Check if this looks like a permission loop — escalate to terminal instead of normal retry
            if (detectPermissionLoop(capturedPath)) {
              logAction("service", "permission_loop_detected", `jsonl:${capturedPath}`, sessionId);
              schedulePermissionEscalation(sessionId, capturedPath);
            } else {
              scheduleServerAutoRetry(sessionId);
            }
          });
        }
      }

      // Detect stalled sessions — defer isSessionActive check to after transaction
      if (metadata.lastMessageRole === "assistant") {
        const silentMs = Date.now() - stat.mtimeMs;
        if (silentMs > STALL_THRESHOLD_MS) {
          const capturedSessionId = sessionId;
          const capturedSilentMs = silentMs;
          postTxActions.push(() => {
            const { isSessionActive } = require("./process-detector");
            if (isSessionActive(capturedSessionId)) {
              logAction("service", "stall_detected", `silent:${Math.round(capturedSilentMs / 60_000)}min`, capturedSessionId);
              scheduleStallContinue(capturedSessionId, 10_000);
            }
          });
        }
      }

      upsertSession.run({
        session_id: sessionId,
        jsonl_path: filePath,
        project_dir: dirName,
        project_path: metadata.projectPath || dirToPath(dirName),
        git_branch: metadata.gitBranch,
        claude_version: metadata.claudeVersion,
        model: metadata.model,
        first_prompt: metadata.firstPrompt,
        last_message: metadata.lastMessage,
        last_message_role: metadata.lastMessageRole,
        message_count: metadata.messageCount,
        total_input_tokens: metadata.totalInputTokens,
        total_output_tokens: metadata.totalOutputTokens,
        created_at: metadata.createdAt,
        modified_at: metadata.modifiedAt,
        file_mtime: stat.mtimeMs,
        file_size: stat.size,
        last_scanned_at: new Date().toISOString(),
      });

      ftsQueue.push({ sessionId, text: metadata.fullText });
      sessionsScanned++;
    }
  });

  // Process in batches with event loop yields between them
  for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
    ftsQueue.length = 0;
    postTxActions.length = 0;

    // Step 1: stat + parse outside transaction
    const items = preprocessBatch(jsonlFiles.slice(i, i + BATCH_SIZE));

    // Step 2: DB writes in transaction (no I/O)
    insertBatch(items);

    // Step 3: deferred actions (execSync, spawn) after transaction releases lock
    for (const action of postTxActions) {
      action();
    }

    // Step 4: FTS indexing outside transaction
    for (const { sessionId, text } of ftsQueue) {
      indexSessionContent(sessionId, text);
    }
    await yieldToEventLoop();
  }

  // Update projects — bulk query instead of per-project SELECT
  const projectDirList = [...projectDirs];
  if (projectDirList.length > 0) {
    const placeholders = projectDirList.map(() => "?").join(",");
    const allStats = db
      .prepare(
        `SELECT project_dir, COUNT(*) as count, MAX(modified_at) as last_activity,
         MAX(project_path) as project_path
         FROM sessions WHERE project_dir IN (${placeholders})
         GROUP BY project_dir`
      )
      .all(...projectDirList) as Array<{
      project_dir: string;
      count: number;
      last_activity: string;
      project_path: string;
    }>;

    const statsMap = new Map(allStats.map((s) => [s.project_dir, s]));

    const updateProjects = db.transaction(() => {
      for (const projectDir of projectDirList) {
        const stats = statsMap.get(projectDir);
        const projectPath = stats?.project_path || dirToPath(projectDir);
        upsertProject.run({
          project_dir: projectDir,
          project_path: projectPath,
          display_name: projectPath.split(/[\\/]/).pop() || projectDir,
          session_count: stats?.count ?? 0,
          last_activity: stats?.last_activity ?? null,
        });
      }
    });
    updateProjects();
  }

  return {
    sessionsScanned,
    sessionsSkipped,
    projectsFound: projectDirs.size,
    duration: Date.now() - start,
  };
}

// Claude stores project dirs as cwd with path separators replaced by "-".
// macOS: "/Users/vova/project" → "-Users-vova-project"
// Windows: "C:\Users\vova\project" → "C--Users-vova-project" (drive colon kept)
function dirToPath(dirName: string): string {
  const restored = dirName.replace(/-/g, "/");
  // On Windows, convert forward slashes to backslashes
  return process.platform === "win32" ? restored.replace(/\//g, "\\") : restored;
}
