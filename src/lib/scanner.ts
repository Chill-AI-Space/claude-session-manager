import { getDb, getSetting, indexSessionContent, logAction, getSessionAlarm, clearSessionAlarm, rearmPersistentAlarm, getExpiredAlarms, isBabysitterDisabled } from "./db";
import { glob } from "glob";
import fs from "fs";
import path from "path";
import { claudeProjectsDir, UUID_RE } from "./utils";
import { iterateLinesSync } from "./utils-server";
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

export function shouldSkipSessionIncremental(
  existingMtime: number,
  fileMtime: number,
  hasFtsIndex: boolean
): boolean {
  return Math.abs(existingMtime - fileMtime) < 1000 && hasFtsIndex;
}

function extractMetadataFromJsonl(filePath: string): JsonlMetadata | null {
  try {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch { return null; }

    const lines = iterateLinesSync(filePath);

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
    let textPartsSize = 0;
    const MAX_FTS_TEXT = 20_000; // Cap FTS text to ~20KB per session (keeps FTS tables manageable)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let createdAt = "";
    let modifiedAt = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        // Track result events — present when Claude exits normally, absent on crash.
        // has_result tracks the CURRENT TURN: reset when a human user message arrives,
        // set when Claude produces a result event. This way has_result=1 means
        // "Claude finished this turn and is waiting for user", not just "ever had a result".
        if (obj.type === "result") {
          hasResult = true;
        }

        if (obj.type === "user" || obj.type === "assistant") {
          // Skip SDK meta-messages (isMeta: true) — these are Claude Code's internal
          // protocol messages injected on resume/compaction ("Continue from where you left off.")
          // They are NOT user input and should not affect state tracking or lastMessage.
          if (obj.isMeta) continue;

          messageCount++;
          // Detect tool_result messages (Claude died mid-execution)
          const isToolResult = obj.type === "user" && Array.isArray(obj.message?.content) &&
              obj.message.content.every((b: { type: string }) => b.type === "tool_result");
          if (isToolResult) {
            lastMessageRole = "tool_result";
          } else {
            lastMessageRole = obj.type;
            // Human user message = new turn starting → reset current-turn result flag
            if (obj.type === "user") hasResult = false;
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
              // Skip babysitter auto-resume messages — they pollute lastMessage context
              const isBabysitterMsg = /^(You crashed mid-tool|You stalled|Your process exited|You appear to have stalled|You were mid-task)/.test(text);
              if (
                text &&
                !text.startsWith("{") &&
                !text.startsWith("[Request interrupted") &&
                !isTaskNotif &&
                !isBabysitterMsg &&
                text.trim().length > 5
              ) {
                if (!firstPrompt) {
                  firstPrompt = text.slice(0, 1000);
                }
                // Always update — last one wins
                lastMessage = text.slice(-1000);
                if (textPartsSize < MAX_FTS_TEXT) {
                  textParts.push(text);
                  textPartsSize += text.length;
                }
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
            // Index assistant text too (capped)
            const content = obj.message?.content;
            if (Array.isArray(content) && textPartsSize < MAX_FTS_TEXT) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  textParts.push(block.text);
                  textPartsSize += block.text.length;
                  if (textPartsSize >= MAX_FTS_TEXT) break;
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
  const existingFtsIds = new Set<string>();
  if (mode === "incremental") {
    const rows = db
      .prepare("SELECT session_id, file_mtime FROM sessions")
      .all() as { session_id: string; file_mtime: number }[];
    for (const row of rows) {
      existingMtimes.set(row.session_id, row.file_mtime);
    }

    const ftsRows = db
      .prepare("SELECT session_id FROM sessions_fts")
      .all() as { session_id: string }[];
    for (const row of ftsRows) {
      existingFtsIds.add(row.session_id);
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
        const hasFtsIndex = existingFtsIds.has(sessionId);
        if (shouldSkipSessionIncremental(existingMtime, fileMtime, hasFtsIndex)) {
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
        db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(sessionId);
        continue;
      }

      projectDirs.add(dirName);

      // Detect newly-crashed sessions → delegate to orchestrator
      // Uses file_mtime change (not just role transition) to catch repeated crashes
      // Skip if session has a result event — that means Claude exited normally
      if (metadata.lastMessageRole === "tool_result" && !metadata.hasResult) {
        const prev = db
          .prepare("SELECT last_message_role, file_mtime FROM sessions WHERE session_id = ?")
          .get(sessionId) as { last_message_role: string | null; file_mtime: number | null } | undefined;
        const isNewCrash = !prev || prev.last_message_role !== "tool_result";
        const isRepeatedCrash = prev?.last_message_role === "tool_result" &&
          prev.file_mtime !== null && Math.abs(stat.mtimeMs - prev.file_mtime) > 1000;
        // Protective age guard: don't fire on brand-new tool_result entries.
        // Gives Claude time to process tool output and write the next assistant message.
        // 30s minimum prevents false positives when scanner fires right after a tool runs.
        const fileAgeMs = Date.now() - stat.mtimeMs;
        const MIN_CRASH_AGE_MS = 90_000;
        if ((isNewCrash || isRepeatedCrash) && fileAgeMs >= MIN_CRASH_AGE_MS) {
          const capturedPath = filePath;
          const capturedIsRepeated = isRepeatedCrash;
          postTxActions.push(() => {
            const { isSessionActive } = require("./process-detector");
            // Process still alive = Claude is executing, not crashed — skip
            if (isSessionActive(sessionId)) return;
            // Session has a self-alarm or disabled babysitter — skip
            if (getSessionAlarm(sessionId) || isBabysitterDisabled(sessionId)) return;
            logAction("service", capturedIsRepeated ? "repeated_crash_detected" : "crash_detected", `jsonl:${capturedPath}`, sessionId);
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
          const capturedHasResult = metadata.hasResult;
          postTxActions.push(() => {
            const { isSessionActive } = require("./process-detector");
            // Session has a self-alarm or disabled babysitter — skip
            if (getSessionAlarm(capturedSessionId) || isBabysitterDisabled(capturedSessionId)) return;
            // Check for permission wait (tool_use pending) OR test word trigger
            const testWord = getSetting("permission_escalation_test_word");
            const isTestTrigger = testWord && testWord.length > 3 && detectTestWordInLastAssistant(capturedPath, testWord);
            if (isSessionActive(capturedSessionId) && (detectPermissionWait(capturedPath) || isTestTrigger)) {
              logAction("service", "permission_wait_detected", `silent:${Math.round(capturedSilentMs / 60_000)}min, ${isTestTrigger ? "test_word_trigger" : "tool_use pending"}`, capturedSessionId);
              getOrchestrator().enqueuePermissionWait(capturedSessionId);
              return; // don't also enqueue stall_continue
            }
            // Regular stall detection (5 min threshold)
            // Skip if Claude completed the turn normally (has_result) — process alive = waiting for user, not stalled
            if (capturedSilentMs > STALL_THRESHOLD_MS && isSessionActive(capturedSessionId) && !capturedHasResult) {
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

  // Post-scan: index Forge sessions from ~/forge/.forge.db
  try {
    const { scanForgeSessions } = await import("./forge-scanner");
    const forgeResult = await scanForgeSessions(db, existingMtimes, mode, upsertSession);
    sessionsScanned += forgeResult.scanned;
    sessionsSkipped += forgeResult.skipped;
  } catch (err) {
    dlog.warn("scanner", `forge scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Post-scan: index Codex sessions from ~/.codex/state_5.sqlite
  try {
    const { scanCodexSessions } = await import("./codex-scanner");
    const codexResult = await scanCodexSessions(db, existingMtimes, mode, upsertSession);
    sessionsScanned += codexResult.scanned;
    sessionsSkipped += codexResult.skipped;
  } catch (err) {
    dlog.warn("scanner", `codex scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Post-scan: detect incomplete exits from DB (catches files skipped by incremental scan)
  detectIncompleteExits(db);

  // Post-scan: fire expired session self-alarms
  checkExpiredAlarms(db);

  // Post-scan: ping delegated sessions that haven't reported back
  detectStalledDelegations(db);

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
  const MAX_AGE_MS = 4 * 60 * 60 * 1000; // Don't auto-resume sessions older than 4 hours

  const cutoffRecent = Date.now() - STALL_THRESHOLD_MS;
  const cutoffOld = Date.now() - MAX_AGE_MS;

  const candidates = db.prepare(`
    SELECT session_id, jsonl_path, file_mtime
    FROM sessions
    WHERE last_message_role = 'assistant'
      AND has_result = 0
      AND file_mtime < ?
      AND file_mtime > ?
      AND (agent_type IS NULL OR agent_type = 'claude')
  `).all(cutoffRecent, cutoffOld) as Array<{
    session_id: string;
    jsonl_path: string;
    file_mtime: number;
  }>;

  for (const session of candidates) {
    // Skip if process is still alive (that's a stall, not incomplete exit)
    if (isSessionActive(session.session_id)) continue;

    // Skip if session has a self-alarm or disabled babysitter
    if (getSessionAlarm(session.session_id) || isBabysitterDisabled(session.session_id)) continue;

    // Skip if orchestrator is already handling this session
    const state = orch.status(session.session_id);
    if (state && !["idle", "completed", "failed"].includes(state.phase)) continue;

    const silentMin = Math.round((Date.now() - session.file_mtime) / 60_000);
    logAction("service", "incomplete_exit_detected", `silent:${silentMin}min (post-scan)`, session.session_id);
    orch.enqueueIncompleteExitResume(session.session_id, session.jsonl_path);
  }
}

/**
 * Ping delegated sessions that have finished work but haven't reported back.
 *
 * A "delegated session" has reply_to_session_id set and delegation_status = 'pending'.
 * After the child session completes (process dead, or has_result=1), we give it a grace
 * period, then periodically remind it to report back. After MAX_PINGS missed reminders,
 * we auto-send a FAILED reply to the parent session.
 */
function detectStalledDelegations(db: ReturnType<typeof getDb>): void {
  const INITIAL_WAIT_MS = 5 * 60 * 1000;   // wait 5 min after completion before first ping
  const PING_INTERVAL_MS = 10 * 60 * 1000;  // 10 min between pings
  const MAX_PINGS = 3;

  const now = Date.now();
  const base = (getSetting("csm_base_url") || "http://localhost:3000").replace(/\/$/, "");

  const candidates = db.prepare(`
    SELECT session_id, reply_to_session_id, delegation_task,
           delegation_ping_count, delegation_last_ping_at,
           has_result, file_mtime, project_path
    FROM sessions
    WHERE delegation_status = 'pending'
      AND reply_to_session_id IS NOT NULL
  `).all() as Array<{
    session_id: string;
    reply_to_session_id: string;
    delegation_task: string | null;
    delegation_ping_count: number | null;
    delegation_last_ping_at: number | null;
    has_result: number;
    file_mtime: number;
    project_path: string;
  }>;

  if (candidates.length === 0) return;

  const { isSessionActive } = require("./process-detector");
  const orch = getOrchestrator();

  for (const session of candidates) {
    // Skip if child process is still running — not done yet
    if (isSessionActive(session.session_id)) continue;

    const pingCount = session.delegation_ping_count ?? 0;
    const lastPingAt = session.delegation_last_ping_at ?? null;
    const completedAt = session.file_mtime;
    const timeSinceCompletion = now - completedAt;

    // Respect grace period before first ping
    if (!lastPingAt && timeSinceCompletion < INITIAL_WAIT_MS) continue;

    // Respect cooldown between pings
    if (lastPingAt && (now - lastPingAt) < PING_INTERVAL_MS) continue;

    if (pingCount >= MAX_PINGS) {
      // Auto-fail: child never reported back after MAX_PINGS attempts
      db.prepare("UPDATE sessions SET delegation_status = 'failed' WHERE session_id = ?")
        .run(session.session_id);

      const parent = db.prepare("SELECT project_path FROM sessions WHERE session_id = ?")
        .get(session.reply_to_session_id) as { project_path: string } | undefined;
      if (!parent) continue;

      const failMsg = [
        `DELEGATION FAILED: Sub-session ${session.session_id} was delegated the task`,
        `"${session.delegation_task || "your task"}" but did not report back after ${MAX_PINGS} reminders.`,
        `The sub-session may have completed the work — check session ${session.session_id} for results.`,
      ].join(" ");

      logAction("service", "delegation_auto_failed",
        `child:${session.session_id} no reply after ${MAX_PINGS} pings`,
        session.reply_to_session_id);

      orch.enqueue({
        sessionId: session.reply_to_session_id,
        type: "resume",
        message: failMsg,
        priority: "high",
      });
    } else {
      // Ping: resume child and ask it to report back
      const nextPing = pingCount + 1;
      db.prepare(
        "UPDATE sessions SET delegation_ping_count = ?, delegation_last_ping_at = ? WHERE session_id = ?"
      ).run(nextPing, now, session.session_id);

      logAction("service", "delegation_ping",
        `ping ${nextPing}/${MAX_PINGS} child:${session.session_id}`,
        session.reply_to_session_id);

      const pingMsg = [
        `[Delegation Contract Reminder — ping ${nextPing}/${MAX_PINGS}]`,
        `You were delegated: "${session.delegation_task || "a task"}"`,
        `You have completed your work but have not reported back to the requesting session.`,
        `Please report your result NOW by running one of these curl commands:`,
        ``,
        `On success:`,
        `  curl -s -X POST "${base}/api/sessions/${session.reply_to_session_id}/reply" \\`,
        `    -H "Content-Type: application/json" \\`,
        `    -d '{"message": "DONE: <brief summary>"}'`,
        ``,
        `On failure:`,
        `  curl -s -X POST "${base}/api/sessions/${session.reply_to_session_id}/reply" \\`,
        `    -H "Content-Type: application/json" \\`,
        `    -d '{"message": "FAILED: <reason>"}'`,
        ``,
        `This is reminder ${nextPing} of ${MAX_PINGS}. After ${MAX_PINGS} missed reminders, the parent will be notified of failure automatically.`,
      ].join("\n");

      orch.enqueue({
        sessionId: session.session_id,
        type: "resume",
        message: pingMsg,
        priority: "normal",
      });
    }
  }
}

/**
 * Fire expired session self-alarms.
 * When a session sets an alarm, it means: "if I'm inactive for check_after_ms, resume me."
 * Fires only when: time elapsed AND session process is dead AND orchestrator is idle for it.
 */
function checkExpiredAlarms(db: ReturnType<typeof getDb>): void {
  const { isSessionActive } = require("./process-detector");
  const orch = getOrchestrator();
  const alarms = getExpiredAlarms();

  for (const alarm of alarms) {
    // Session still alive — don't interrupt it, alarm stays active
    if (isSessionActive(alarm.session_id)) continue;

    // Orchestrator already handling this session
    const state = orch.status(alarm.session_id);
    if (state && !["idle", "completed", "failed"].includes(state.phase)) continue;

    logAction("service", "alarm_fired", `[${alarm.mode}] ${alarm.message.slice(0, 100)}`, alarm.session_id);
    orch.enqueue({
      sessionId: alarm.session_id,
      type: "resume",
      message: alarm.message,
      priority: "high",
    });
    if (alarm.mode === "once") {
      // One-shot: consume the alarm
      clearSessionAlarm(alarm.session_id);
    } else {
      // Persistent: re-arm the clock so it won't fire again until session goes idle for check_after_ms
      rearmPersistentAlarm(alarm.session_id);
    }
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
