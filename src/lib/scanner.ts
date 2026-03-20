import { getDb, getSetting, indexSessionContent, logAction } from "./db";
import { glob } from "glob";
import fs from "fs";
import path from "path";
import { claudeProjectsDir, UUID_RE } from "./utils";
import { getOrchestrator, STALL_THRESHOLD_MS, PERMISSION_WAIT_THRESHOLD_MS, detectPermissionWait, detectTestWordInLastAssistant } from "./orchestrator";

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
  hasResult: boolean;
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
    const lines = content.split(/\r?\n/).filter((l) => l.trim());

    let sessionId = "";
    let projectPath = "";
    let gitBranch: string | null = null;
    let claudeVersion: string | null = null;
    let model: string | null = null;
    let firstPrompt: string | null = null;
    let lastMessage: string | null = null;
    let lastMessageRole: string | null = null;
    let hasResult = false;
    let messageCount = 0;
    const textParts: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let createdAt = "";
    let modifiedAt = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        // Track result events — present when Claude exits normally, absent on crash
        if (obj.type === "result") {
          hasResult = true;
        }

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
      hasResult,
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
  const dlog = require("./debug-logger");
  dlog.info("scanner", `scan started (${mode})`);
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
      has_result, message_count, total_input_tokens, total_output_tokens,
      created_at, modified_at, file_mtime, file_size, last_scanned_at
    ) VALUES (
      @session_id, @jsonl_path, @project_dir, @project_path,
      @git_branch, @claude_version, @model, @first_prompt, @last_message, @last_message_role,
      @has_result, @message_count, @total_input_tokens, @total_output_tokens,
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
      has_result = @has_result,
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

      // Detect newly-crashed sessions → delegate to orchestrator
      // Uses file_mtime change (not just role transition) to catch repeated crashes
      if (metadata.lastMessageRole === "tool_result") {
        const prev = db
          .prepare("SELECT last_message_role, file_mtime FROM sessions WHERE session_id = ?")
          .get(sessionId) as { last_message_role: string | null; file_mtime: number | null } | undefined;
        const isNewCrash = !prev || prev.last_message_role !== "tool_result";
        const isRepeatedCrash = prev?.last_message_role === "tool_result" &&
          prev.file_mtime !== null && Math.abs(stat.mtimeMs - prev.file_mtime) > 1000;
        if (isNewCrash || isRepeatedCrash) {
          logAction("service", isRepeatedCrash ? "repeated_crash_detected" : "crash_detected", `jsonl:${filePath}`, sessionId);
          const capturedPath = filePath;
          postTxActions.push(() => {
            getOrchestrator().enqueueCrashRetry(sessionId, capturedPath);
          });
        }
      }

      // Detect stalled sessions (process alive but not writing) → delegate to orchestrator
      // Note: incomplete_exit (process dead) is handled by detectIncompleteExits() post-scan
      if (metadata.lastMessageRole === "assistant") {
        const silentMs = Date.now() - stat.mtimeMs;

        // Permission wait: shorter threshold (2 min default) — Claude proposed tool_use but
        // nobody approved it. Kill the stuck process and resume with skip-permissions.
        const permWaitMs = parseInt(getSetting("permission_wait_threshold_ms") || String(PERMISSION_WAIT_THRESHOLD_MS), 10);
        if (silentMs > permWaitMs) {
          const capturedSessionId = sessionId;
          const capturedPath = filePath;
          const capturedSilentMs = silentMs;
          postTxActions.push(() => {
            const { isSessionActive } = require("./process-detector");
            // Check for permission wait (tool_use pending) OR test word trigger
            const testWord = getSetting("permission_escalation_test_word");
            const isTestTrigger = testWord && testWord.length > 3 && detectTestWordInLastAssistant(capturedPath, testWord);
            if (isSessionActive(capturedSessionId) && (detectPermissionWait(capturedPath) || isTestTrigger)) {
              logAction("service", "permission_wait_detected", `silent:${Math.round(capturedSilentMs / 60_000)}min, ${isTestTrigger ? "test_word_trigger" : "tool_use pending"}`, capturedSessionId);
              getOrchestrator().enqueuePermissionWait(capturedSessionId);
              return; // don't also enqueue stall_continue
            }
            // Regular stall detection (5 min threshold)
            if (capturedSilentMs > STALL_THRESHOLD_MS && isSessionActive(capturedSessionId)) {
              logAction("service", "stall_detected", `silent:${Math.round(capturedSilentMs / 60_000)}min`, capturedSessionId);
              getOrchestrator().enqueueStallContinue(capturedSessionId);
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
        has_result: metadata.hasResult ? 1 : 0,
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

  // Post-scan: detect incomplete exits from DB (catches files skipped by incremental scan)
  detectIncompleteExits(db);

  const result = {
    sessionsScanned,
    sessionsSkipped,
    projectsFound: projectDirs.size,
    duration: Date.now() - start,
  };
  dlog.info("scanner", `scan complete: ${sessionsScanned} scanned, ${sessionsSkipped} skipped, ${result.duration}ms`, result);
  return result;
}

/**
 * Post-scan detection of incomplete exits.
 * Queries the DB for sessions where:
 *  - last_message_role = 'assistant' (Claude was about to act)
 *  - has_result = 0 (no result event = didn't finish normally)
 *  - file is older than STALL_THRESHOLD_MS (enough time has passed)
 *  - not too old (< 30 min — stale sessions shouldn't auto-resume)
 *
 * This runs AFTER the main scan, so it catches files that were
 * skipped by incremental mode (same mtime → skipped → in-loop check never fires).
 */
function detectIncompleteExits(db: ReturnType<typeof getDb>): void {
  const { isSessionActive } = require("./process-detector");
  const orch = getOrchestrator();
  const MAX_AGE_MS = 30 * 60 * 1000; // Don't auto-resume sessions older than 30 min

  const cutoffRecent = Date.now() - STALL_THRESHOLD_MS;
  const cutoffOld = Date.now() - MAX_AGE_MS;

  const candidates = db.prepare(`
    SELECT session_id, jsonl_path, file_mtime
    FROM sessions
    WHERE last_message_role = 'assistant'
      AND file_mtime < ?
      AND file_mtime > ?
  `).all(cutoffRecent, cutoffOld) as Array<{
    session_id: string;
    jsonl_path: string;
    file_mtime: number;
  }>;

  for (const session of candidates) {
    // Skip if process is still alive (that's a stall, not incomplete exit)
    if (isSessionActive(session.session_id)) continue;

    // Skip if orchestrator is already handling this session
    const state = orch.status(session.session_id);
    if (state && !["idle", "completed", "failed"].includes(state.phase)) continue;

    const silentMin = Math.round((Date.now() - session.file_mtime) / 60_000);
    logAction("service", "incomplete_exit_detected", `silent:${silentMin}min (post-scan)`, session.session_id);
    orch.enqueueIncompleteExitResume(session.session_id, session.jsonl_path);
  }
}

// Claude stores project dirs as cwd with path separators replaced by "-".
// macOS: "/Users/vova/project" → "-Users-vova-project"
// Windows: "C:\Users\vova\project" → "C:-Users-vova-project"
// NOTE: This is a lossy operation — hyphens in folder names are indistinguishable
// from path separators. Prefer metadata.projectPath when available (line 711).
function dirToPath(dirName: string): string {
  if (process.platform === "win32") {
    // Handle Windows drive letter: "C:-Users-vova-project" → "C:\Users\vova\project"
    const driveMatch = dirName.match(/^([A-Za-z]):-(.*)$/);
    if (driveMatch) {
      return driveMatch[1] + ":\\" + driveMatch[2].replace(/-/g, "\\");
    }
    return dirName.replace(/-/g, "\\");
  }
  return dirName.replace(/-/g, "/");
}
