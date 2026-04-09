/**
 * Session Orchestration Layer
 *
 * Centralizes all session lifecycle management:
 * - start / resume / stop
 * - crash detection → auto-retry (with max retries)
 * - stall detection → auto-continue
 * - permission loop → terminal escalation
 * - task queue with priority + concurrency + dedup
 *
 * Replaces the scattered Set+setTimeout patterns from scanner.ts.
 * API routes become thin wrappers.
 */
import { EventEmitter } from "events";
import spawn from "cross-spawn";
import { getDb, getSetting, logAction } from "./db";
import { getClaudePath } from "./claude-bin";
import { getCleanEnv, claudeProjectsDir } from "./utils";
import { createSSEStream, sseResponse } from "./claude-runner";
import { killSessionProcesses, isSessionActive } from "./process-detector";
import { openInTerminal } from "./terminal-launcher";
import { scanSessions } from "./scanner";
import { generateTitleBatch } from "./title-generator";
import * as dlog from "./debug-logger";
import type { SessionRow } from "./types";
import { initRelayIfEnabled } from "./relay-client";
import fs from "fs";
import path from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionPhase =
  | "idle"
  | "running"
  | "completed"
  | "crashed"
  | "retrying"
  | "stalled"
  | "continuing"
  | "failed";

export interface SessionState {
  sessionId: string;
  phase: SessionPhase;
  projectPath: string;
  pid: number | null;
  retryCount: number;
  skipCount: number; // how many times isWaitingForUser skipped auto-resume
  lastActivity: number;
  startedAt: number;
  error?: string;
  onCompleteUrl?: string; // webhook to POST when session finishes
  replyToSessionId?: string; // parent session expecting a DONE/FAILED reply
  delegationTask?: string; // brief description of what was delegated
}

export type TaskType =
  | "start"
  | "resume"
  | "crash_retry"
  | "stall_continue"
  | "incomplete_exit"
  | "permission_escalation"
  | "permission_wait";

export type TaskPriority = "high" | "normal" | "low";

interface QueuedTask {
  id: string;
  sessionId: string;
  type: TaskType;
  priority: TaskPriority;
  delayMs: number;
  scheduledAt: number;
  execute: () => Promise<void>;
}

export interface QueueStatus {
  pending: number;
  running: number;
  maxConcurrent: number;
  tasks: Array<{
    id: string;
    type: TaskType;
    priority: TaskPriority;
    sessionId: string;
    state: "waiting" | "delayed" | "running";
  }>;
}

// ── Priority ordering ────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

// ── TaskQueue ────────────────────────────────────────────────────────────────

class TaskQueue {
  private pending: QueuedTask[] = [];
  private running = new Map<string, QueuedTask>();
  private delayTimers = new Map<string, NodeJS.Timeout>();
  private maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Add a task. Returns false if duplicate (same id already queued/running/delayed). */
  add(task: QueuedTask): boolean {
    if (this.running.has(task.id)) return false;
    if (this.pending.some((t) => t.id === task.id)) return false;
    if (this.delayTimers.has(task.id)) return false;

    if (task.delayMs > 0) {
      const timer = setTimeout(() => {
        this.delayTimers.delete(task.id);
        this.pending.push(task);
        this.sortPending();
        this.tick();
      }, task.delayMs);
      this.delayTimers.set(task.id, timer);
      return true;
    }

    this.pending.push(task);
    this.sortPending();
    this.tick();
    return true;
  }

  cancel(taskId: string): boolean {
    const timer = this.delayTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.delayTimers.delete(taskId);
      return true;
    }
    const idx = this.pending.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      return true;
    }
    return false;
  }

  cancelForSession(sessionId: string): void {
    for (const [id, timer] of this.delayTimers) {
      if (id.endsWith(`:${sessionId}`)) {
        clearTimeout(timer);
        this.delayTimers.delete(id);
      }
    }
    this.pending = this.pending.filter((t) => t.sessionId !== sessionId);
  }

  getStatus(): QueueStatus {
    const tasks: QueueStatus["tasks"] = [];
    for (const [id] of this.delayTimers) {
      const [type] = id.split(":");
      const sessionId = id.slice(type.length + 1);
      tasks.push({ id, type: type as TaskType, priority: "normal", sessionId, state: "delayed" });
    }
    for (const t of this.pending) {
      tasks.push({ id: t.id, type: t.type, priority: t.priority, sessionId: t.sessionId, state: "waiting" });
    }
    for (const [, t] of this.running) {
      tasks.push({ id: t.id, type: t.type, priority: t.priority, sessionId: t.sessionId, state: "running" });
    }
    return {
      pending: this.pending.length + this.delayTimers.size,
      running: this.running.size,
      maxConcurrent: this.maxConcurrent,
      tasks,
    };
  }

  private sortPending(): void {
    this.pending.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.scheduledAt - b.scheduledAt;
    });
  }

  private tick(): void {
    while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.running.set(task.id, task);
      this.executeTask(task);
    }
  }

  private async executeTask(task: QueuedTask): Promise<void> {
    try {
      await task.execute();
    } catch (err) {
      dlog.error("orchestrator", `task ${task.id} failed: ${err}`);
    } finally {
      this.running.delete(task.id);
      this.tick();
    }
  }
}

// ── Shared CLI arg builder ──────────────────────────────────────────────────

export function buildCliArgs(opts: {
  sessionId?: string;
  message: string;
  includeMaxTurns?: boolean;
  model?: string;
  appendSystemPrompt?: string;
}): string[] {
  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const effort = getSetting("effort_level") || "high";
  const args: string[] = [];

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  args.push("-p", opts.message);
  args.push("--output-format", "stream-json");
  args.push("--verbose");
  args.push("--effort", effort);

  const model = opts.model || getSetting("claude_model") || "claude-sonnet-4-6";
  args.push("--model", model);

  if (opts.includeMaxTurns !== false && opts.sessionId) {
    const maxTurns = getSetting("max_turns") || "80";
    args.push("--max-turns", maxTurns);
  }

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  return args;
}

/** Build the system prompt context block injected when inject_session_context is enabled. */
function buildSessionContextPrompt(sessionId?: string): string | undefined {
  if (getSetting("inject_session_context") !== "true") return undefined;
  const base = (getSetting("csm_base_url") || "http://localhost:3000").replace(/\/$/, "");
  const lines = ["[Session Manager Context]"];
  if (sessionId) {
    lines.push(`Session ID: ${sessionId}`);
    lines.push(`Callback URL: POST ${base}/api/sessions/${sessionId}/reply  body: {"message":"..."}`);
    lines.push(`Self-alarm: POST ${base}/api/sessions/${sessionId}/alarm  body: {"message":"<what to do when resumed>","check_after_ms":180000}`);
    lines.push(`  — If you set an alarm and then die/stall, babysitter will resume you with your message after check_after_ms.`);
    lines.push(`  — While alarm is active, babysitter skips normal crash/stall handling for your session.`);
    lines.push(`  — Cancel: DELETE ${base}/api/sessions/${sessionId}/alarm`);
  } else {
    lines.push(`Callback URL pattern: POST ${base}/api/sessions/{SESSION_ID}/reply  body: {"message":"..."}`);
    lines.push("(Your SESSION_ID is assigned at session start and visible in your conversation metadata.)");
  }
  lines.push(`Start sub-session: POST ${base}/api/sessions/start  body: {"path":"...","message":"..."}`);
  lines.push(`Active sessions: GET ${base}/api/sessions`);
  lines.push("[End Context]");
  return lines.join("\n");
}

/** Build the delegation contract block injected when a session is spawned with reply_to_session_id. */
function buildDelegationPrompt(replyToSessionId: string, delegationTask: string | undefined, base: string): string {
  const lines = [
    "[Delegation Contract]",
    `You were spawned to handle a delegated task${delegationTask ? `: "${delegationTask}"` : ""}.`,
    `When your task is complete — success or failure — you MUST report back by calling one of these curl commands:`,
    ``,
    `On success:`,
    `  curl -s -X POST "${base}/api/sessions/${replyToSessionId}/reply" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"message": "DONE: <brief summary of what was accomplished>"}'`,
    ``,
    `On failure:`,
    `  curl -s -X POST "${base}/api/sessions/${replyToSessionId}/reply" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"message": "FAILED: <reason why the task could not be completed>"}'`,
    ``,
    `Do NOT finish your work without calling one of these. The parent session is waiting for your reply.`,
    "[End Delegation Contract]",
  ];
  return lines.join("\n");
}

/** Parse a stream-json line and emit simplified SSE events. */
export function parseStreamLine(
  obj: Record<string, unknown>,
  send: (data: Record<string, unknown>) => void,
  callbacks?: { onSessionId?: (id: string) => void; onText?: (text: string) => void; verbose?: boolean }
): void {
  const sid = (obj.session_id ?? obj.sessionId) as string | undefined;
  if (sid) callbacks?.onSessionId?.(sid);
  const verbose = callbacks?.verbose ?? false;

  if (obj.type === "assistant" && obj.message) {
    const msg = obj.message as {
      model?: string;
      content?: Array<{ type: string; text?: string; name?: string; thinking?: string; input?: Record<string, unknown> }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    if (msg.content) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          send({ type: "text", text: block.text });
          callbacks?.onText?.(block.text);
        } else if (block.type === "tool_use") {
          send({ type: "status", text: `Using tool: ${block.name}` });
          if (verbose && block.input) {
            send({ type: "debug", subtype: "tool_input", tool: block.name, input: block.input });
          }
        } else if (verbose && block.type === "thinking" && block.thinking) {
          send({ type: "debug", subtype: "thinking", text: block.thinking });
        }
      }
    }
    if (verbose && msg.usage) {
      send({ type: "debug", subtype: "usage", usage: msg.usage, model: msg.model });
    }
  } else if (obj.type === "result") {
    send({
      type: "done",
      result: obj.result,
      is_error: obj.is_error,
      cost: obj.total_cost_usd,
    });
  } else if (verbose && obj.type === "system") {
    send({ type: "debug", subtype: "system", event: obj });
  }
}

// ── Stall / crash helpers ───────────────────────────────────────────────────

export const STALL_THRESHOLD_MS = 5 * 60 * 1000;
export const PERMISSION_WAIT_THRESHOLD_MS = 2 * 60 * 1000; // 2 min — shorter than stall

/** Check if the JSONL ends with a result event (Claude exited normally). */
export function hasResultEvent(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 8 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift(); // partial first line
    // Check last 10 lines for a result event
    for (const line of lines.slice(-10)) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "result") return true;
      } catch { /* skip */ }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the last assistant message indicates Claude is either:
 * (A) Asking the user a question / waiting for input, OR
 * (B) Reporting task completion (done, finished, here's the result).
 *
 * Returns true if auto-resume should be SKIPPED (i.e. Claude is waiting or done).
 * Returns false if Claude appears to be mid-task (should auto-resume).
 */
/**
 * Check if Claude's last message indicates we should NOT auto-resume.
 *
 * @param mode
 *   - "stall": process alive — skip if asking question OR reporting completion
 *   - "incomplete_exit": process dead, no result event — skip ONLY if asking question
 *     (completion check is wrong here: if Claude said "done" but process died without
 *      result event, that's abnormal and we SHOULD resume)
 */
async function isWaitingForUser(lastAssistantText: string, mode: "stall" | "incomplete_exit" = "stall"): Promise<boolean> {
  if (!lastAssistantText.trim()) return false;

  const lower = lastAssistantText.toLowerCase();

  // Quick pattern match: explicit questions directed at user
  // NOTE: /\?\s*$/ was removed — too aggressive, catches rhetorical "?" in explanations
  // NOTE: \b does NOT work with Cyrillic in JS — \w is [a-zA-Z0-9_] only.
  // Use (?=[\s.,!?:;\-]|$) or (?:^|[\s]) for Cyrillic word boundaries.
  const questionPatterns = [
    /which (option|approach|do you|would you)/,
    /do you want/,
    /should i (proceed|continue|go ahead)/,
    /let me know/,
    /please (confirm|clarify|specify|choose|select|provide)/,
    /what (would|do) you (like|prefer|want)/,
    /could you (provide|send|share|clarify|specify)/,
    /подтверди|выбери|какой вариант|хотите/,
    /напиши|пришли|отправь|укажи|предоставь|уточни/,
    /не (пришл[оиа]|дош[ёе]л|получил)|обрывается|пусто(?=[\s.,!?]|$)/,
    /жду(?=[\s.,!?]|$)|когда скажешь|когда скажете|ожидаю (ваш|твой)/,
  ];
  if (questionPatterns.some((re) => re.test(lower))) return true;

  // Completion patterns — applies to BOTH modes.
  // If Claude explicitly said "task done" / "всё готово", don't poke it regardless of mode.
  // NOTE: \b works fine for English patterns but NOT for Cyrillic — see above.
  const completionPatterns = [
    /\b(all done|all set|task (is |has been )?complet|that'?s it)\b/,
    /\b(here('s| is| are) (the |your |a )?(final|complete|full|result|summary|output))\b/,
    /\bsuccessfully (deployed|published|created|updated|completed|finished|built|pushed)\b/,
    /\b(everything is|changes are|all changes|code is|build is|deploy is) (now |)(done|ready|live|complete|deployed)\b/,
    /готов[оа]?(?=[\s.,!?:;\-]|$)|завершен|опубликовано/,
    /задач[аи] выполнен|всё сделано|все изменения|полностью готов/,
    /готово к работе|готов к запуску|можешь (запуск|открыва|проверя)/,
  ];
  if (completionPatterns.some((re) => re.test(lower))) return true;

  // For incomplete exits: skip LLM — regex-only, be aggressive about resuming.
  // Question + completion patterns above already caught the obvious cases.
  if (mode === "incomplete_exit") return false;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return false;

    const prompt = `Is this message either (A) asking the user a question or requesting input before proceeding, OR (B) a completion/summary message indicating the task is finished? Answer YES if A or B. Answer NO only if the message indicates more work is about to be done.\n\nMessage:\n${lastAssistantText.slice(0, 1500)}`;

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
          content: prompt,
        }],
      }),
    });

    if (!response.ok) return false;
    const json = await response.json();
    const answer = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
    return answer.startsWith("YES");
  } catch {
    return false;
  }
}

const BABYSITTER_PREFIXES = [
  "You crashed mid-tool",
  "You stalled",
  "Your process exited",
  "You appear to have stalled",
  "You were mid-task",
  "Continue from where you left off",
];

/**
 * Detect babysitter resume loops in JSONL.
 *
 * Scans backwards through the tail of the JSONL counting consecutive
 * babysitter-initiated "segments" (babysitter prompt → assistant response).
 * A segment is considered UNPRODUCTIVE if the assistant made ≤ 3 tool_use calls
 * between two babysitter prompts — i.e. Claude didn't do meaningful work.
 *
 * Returns { resumes, unproductiveCount }:
 *   - resumes: total consecutive babysitter-initiated user messages
 *   - unproductiveCount: how many of those segments had ≤ 3 tool calls
 */
function detectBabysitterLoop(jsonlPath: string): { resumes: number; unproductiveCount: number } {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 64 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift();
    lines.reverse();

    let resumes = 0;
    let unproductiveCount = 0;
    let toolCallsInSegment = 0;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        if (obj.type === "assistant") {
          // Count tool_use blocks in assistant messages
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            toolCallsInSegment += content.filter((b: { type: string }) => b.type === "tool_use").length;
          }
          continue;
        }

        if (obj.type !== "user") break;

        // Skip SDK meta-messages — they are internal Claude Code protocol messages
        // (e.g. "Continue from where you left off." injected on --resume),
        // not real babysitter pokes or user input.
        if (obj.isMeta) continue;

        const content = obj.message?.content;
        const text = typeof content === "string" ? content
          : Array.isArray(content)
            ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("")
            : "";

        if (BABYSITTER_PREFIXES.some(p => text.startsWith(p))) {
          resumes++;
          if (toolCallsInSegment <= 3) unproductiveCount++;
          toolCallsInSegment = 0; // reset for next segment
        } else {
          break; // real user message — stop
        }
      } catch { /* skip */ }
    }
    return { resumes, unproductiveCount };
  } catch {
    return { resumes: 0, unproductiveCount: 0 };
  }
}

/**
 * Check if the last assistant message in JSONL has tool_use blocks.
 * If true → Claude was actively calling tools when the process died → genuine incomplete exit.
 * If false → Claude's last output was text-only → it finished speaking, process should have
 *            exited normally. Resuming text-only exits is almost always a false positive.
 */
function lastAssistantHasToolUse(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 32 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift();
    lines.reverse();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message?.content) continue;
        const content = obj.message.content;
        if (Array.isArray(content)) {
          return content.some((b: { type: string }) => b.type === "tool_use");
        }
        return false; // string content = text only
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Returns true if the last meaningful event in the JSONL is a result event.
 * When true, Claude completed its turn and is waiting for user — NOT stalled.
 * Works for stream-json sessions (result event present). For terminal sessions
 * without stream-json, returns false (falls through to LLM check).
 */
function isLastEventResult(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 2048;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift(); // first line may be truncated

    // Walk backwards — find first parseable line with a meaningful type
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === "result") return true;
        if (obj.type === "user" || obj.type === "assistant") return false;
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return false;
}

function extractLastAssistantText(jsonlPath: string): string {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 64 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
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
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return "";
}

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

export function detectPermissionLoop(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 128 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift();

    let permissionHits = 0;
    const recentLines = lines.slice(-30);
    for (const line of recentLines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block.type === "tool_result") {
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((b: { text?: string }) => b.text || "").join(" ")
                  : "";
              if (PERMISSION_PATTERNS.some((re) => re.test(text))) permissionHits++;
            }
          }
        }
        if (obj.type === "assistant" && obj.message?.content) {
          const content = obj.message.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")
              : "";
          if (PERMISSION_PATTERNS.some((re) => re.test(text))) permissionHits++;
        }
      } catch { /* skip */ }
    }
    return permissionHits >= 2;
  } catch {
    return false;
  }
}

/**
 * Detect if a session is stuck waiting for tool permission approval.
 * Pattern: last JSONL event is assistant with tool_use, no subsequent tool_result.
 * This means Claude proposed a tool but the process is blocked on stdin
 * waiting for the user to approve/deny.
 */
export function detectPermissionWait(jsonlPath: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 64 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift(); // partial first line

    // Walk backwards to find the last meaningful event
    let lastIsToolUse = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);

        // If we hit a tool_result first, Claude already got past approval
        if (obj.type === "user" && Array.isArray(obj.message?.content)) {
          if (obj.message.content.some((b: { type: string }) => b.type === "tool_result")) {
            return false;
          }
        }

        // If we hit a result event, session completed normally
        if (obj.type === "result") return false;

        // Check if the last assistant message has tool_use blocks
        if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          lastIsToolUse = obj.message.content.some(
            (b: { type: string }) => b.type === "tool_use"
          );
          break; // found the last assistant message
        }
      } catch { /* skip malformed */ }
    }

    return lastIsToolUse;
  } catch {
    return false;
  }
}

/**
 * Check if the last assistant message contains a specific test word.
 * Used to manually trigger permission escalation for testing.
 */
export function detectTestWordInLastAssistant(jsonlPath: string, testWord: string): boolean {
  try {
    const stat = fs.statSync(jsonlPath);
    const TAIL_BYTES = 64 * 1024;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString("utf-8").split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift();

    // Walk backwards to find the last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === "assistant" && obj.message?.content) {
          const content = obj.message.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join(" ")
              : "";
          return text.includes(testWord);
        }
      } catch { /* skip */ }
    }
    return false;
  } catch {
    return false;
  }
}

// ── SessionOrchestrator ──────────────────────────────────────────────────────

class SessionOrchestrator extends EventEmitter {
  private states = new Map<string, SessionState>();
  private queue: TaskQueue;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private permissionCheckTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    const maxConcurrent = parseInt(getSetting("orchestrator_max_concurrent") || "3", 10);
    this.queue = new TaskQueue(maxConcurrent);

    // Periodic cleanup of stale states (every 10 min)
    this.cleanupTimer = setInterval(() => this.cleanupStaleStates(), 10 * 60 * 1000);

    // Periodic permission-wait check — catches sessions stuck on
    // tool approval that the scan misses (scan skips frozen-mtime files)
    const permCheckMs = parseInt(getSetting("permission_check_interval_ms") || "180000", 10);
    if (permCheckMs > 0) {
      this.permissionCheckTimer = setInterval(() => this.periodicPermissionCheck(), permCheckMs);
    }
  }

  // ── Public API: start ─────────────────────────────────────────────────────

  /**
   * Start a new Claude session. Returns SSE stream.
   * @param correlationId — optional client-generated ID for end-to-end tracking
   * @param verbose — when true, emit extra debug events (tool inputs, tokens, thinking)
   * @param previousSessionId — ID of the session this was spawned from (context carry-over)
   * @param onCompleteUrl — optional webhook URL to POST when the session finishes
   * @param replyToSessionId — if set, child must POST DONE/FAILED back to this session when done
   * @param delegationTask — brief description of what was delegated (shown in pings)
   */
  start(projectPath: string, message: string, correlationId?: string, verbose = false, model?: string, previousSessionId?: string, onCompleteUrl?: string, replyToSessionId?: string, delegationTask?: string): ReadableStream {
    let sessionId: string | null = null;
    let lastMessageUpdate = 0; // throttle DB writes
    const base = (getSetting("csm_base_url") || "http://localhost:3000").replace(/\/$/, "");
    const contextPrompt = buildSessionContextPrompt(); // no sessionId yet for new sessions
    const delegationPrompt = replyToSessionId
      ? buildDelegationPrompt(replyToSessionId, delegationTask, base)
      : undefined;
    const fullSystemPrompt = [contextPrompt, delegationPrompt].filter(Boolean).join("\n\n") || undefined;
    const args = buildCliArgs({ message, model, appendSystemPrompt: fullSystemPrompt });
    const spawnedAt = Date.now();

    if (correlationId) {
      logAction("service", "session_start_spawning", JSON.stringify({ correlationId, path: projectPath }));
    }

    const stream = createSSEStream({
      args,
      cwd: projectPath,
      onLine: (obj, send) => {
        parseStreamLine(obj, send, {
          verbose,
          onText: (text) => {
            // Live-update last_message in DB so running sessions show current activity
            const now = Date.now();
            if (sessionId && now - lastMessageUpdate > 2000) {
              lastMessageUpdate = now;
              try {
                getDb().prepare(
                  "UPDATE sessions SET last_message = ?, modified_at = ? WHERE session_id = ?"
                ).run(text.slice(0, 500), new Date().toISOString(), sessionId);
              } catch { /* non-critical */ }
            }
          },
          onSessionId: (id) => {
            if (!sessionId) {
              sessionId = id;
              send({ type: "session_id", session_id: id });
              const payload = correlationId
                ? JSON.stringify({ correlationId, elapsedMs: Date.now() - spawnedAt })
                : undefined;
              logAction("service", "start_web_session", projectPath, id, payload);
              this.states.set(id, {
                sessionId: id,
                phase: "running",
                projectPath,
                pid: null,
                retryCount: 0,
                skipCount: 0,
                lastActivity: Date.now(),
                startedAt: Date.now(),
                onCompleteUrl,
                replyToSessionId,
                delegationTask,
              });
              // Insert a placeholder row immediately so the session is visible in /api/sessions
              // while it's still running (full data is filled in by scanSessions on close)
              try {
                const db = getDb();
                const now = new Date().toISOString();
                const projectDir = projectPath.replace(/[\\/]/g, "-");
                const jsonlPath = path.join(claudeProjectsDir(), projectDir, `${id}.jsonl`);
                db.prepare(`
                  INSERT OR IGNORE INTO sessions (
                    session_id, jsonl_path, project_dir, project_path,
                    first_prompt, created_at, modified_at, file_mtime, file_size, last_scanned_at,
                    reply_to_session_id, delegation_task, delegation_status
                  ) VALUES (
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, 0, ?,
                    ?, ?, ?
                  )
                `).run(
                  id, jsonlPath, projectDir, projectPath,
                  message.slice(0, 500), now, now, Date.now(), now,
                  replyToSessionId ?? null,
                  delegationTask ?? null,
                  replyToSessionId ? "pending" : null,
                );
              } catch { /* non-critical — full data comes from scan on close */ }
              this.emit("session:started", { sessionId: id, projectPath });
            }
          },
        });
      },
      onClose: async () => {
        if (sessionId) {
          this.transition(sessionId, "completed");
          this.emit("session:completed", { sessionId });
        }
        if (correlationId) {
          logAction("service", "session_start_process_closed", JSON.stringify({ correlationId, elapsedMs: Date.now() - spawnedAt }), sessionId ?? undefined);
        }
        try {
          await scanSessions("incremental");
          if (correlationId) {
            logAction("service", "session_start_scan_done", JSON.stringify({ correlationId, elapsedMs: Date.now() - spawnedAt }), sessionId ?? undefined);
          }
          if (previousSessionId && sessionId) {
            try {
              getDb().prepare("UPDATE sessions SET previous_session_id = ? WHERE session_id = ?").run(previousSessionId, sessionId);
            } catch { /* non-critical */ }
          }
          generateTitleBatch(1).catch(() => {});
        } catch { /* non-critical */ }
        // Fire on_complete webhook if provided
        const completeUrl = onCompleteUrl || (sessionId ? this.states.get(sessionId)?.onCompleteUrl : undefined);
        if (completeUrl && sessionId) {
          fetch(completeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, event: "completed" }),
          }).catch(() => {}); // fire-and-forget
        }
      },
      onProc: (proc) => {
        if (correlationId) {
          logAction("service", "session_start_pid_assigned", JSON.stringify({ correlationId, pid: proc.pid }), sessionId ?? undefined);
        }
        if (sessionId) {
          const state = this.states.get(sessionId);
          if (state) state.pid = proc.pid ?? null;
        }
      },
    });

    return stream;
  }

  // ── Public API: resume ────────────────────────────────────────────────────

  /**
   * Resume an existing session with a new message. Returns SSE stream.
   * @param verbose — when true, emit extra debug events (tool inputs, tokens, thinking)
   */
  resume(sessionId: string, message: string, projectPath: string, verbose = false): ReadableStream {
    // Cancel any pending stall_continue — user is actively replying
    this.queue.cancel(`stall_continue:${sessionId}`);

    const contextPrompt = buildSessionContextPrompt(sessionId);
    const args = buildCliArgs({ sessionId, message, includeMaxTurns: true, appendSystemPrompt: contextPrompt });

    this.states.set(sessionId, {
      sessionId,
      phase: "running",
      projectPath,
      pid: null,
      retryCount: this.states.get(sessionId)?.retryCount ?? 0,
      skipCount: this.states.get(sessionId)?.skipCount ?? 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    });

    const stream = createSSEStream({
      args,
      cwd: projectPath,
      onLine: (obj, send) => {
        parseStreamLine(obj, send, { verbose });
        const state = this.states.get(sessionId);
        if (state) state.lastActivity = Date.now();
      },
      onClose: () => {
        this.transition(sessionId, "completed");
        this.emit("session:completed", { sessionId });
      },
      onProc: (proc) => {
        const state = this.states.get(sessionId);
        if (state) state.pid = proc.pid ?? null;
      },
    });

    this.emit("session:resumed", { sessionId, projectPath });
    return stream;
  }

  // ── Public API: Forge start ───────────────────────────────────────────────

  /**
   * Start a new Forge session. Pre-generates UUID, emits session_id immediately.
   * Returns SSE stream.
   */
  startForge(projectPath: string, message: string, model?: string): ReadableStream {
    const { randomUUID } = require("crypto") as typeof import("crypto");
    const { createForgeSSEStream } = require("./forge-runner") as typeof import("./forge-runner");
    const { insertPendingForgeSession } = require("./db") as typeof import("./db");
    const conversationId: string = randomUUID();

    // Pre-insert into DB immediately so the session appears in the list
    // and the prompt is preserved even if Forge fails to start.
    insertPendingForgeSession(conversationId, projectPath, message);

    this.states.set(conversationId, {
      sessionId: conversationId,
      phase: "running",
      projectPath,
      pid: null,
      retryCount: 0,
      skipCount: 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    });

    logAction("service", "forge_start", projectPath, conversationId);
    this.emit("session:started", { sessionId: conversationId, projectPath });

    const stream = createForgeSSEStream({
      conversationId,
      message,
      projectPath,
      model,
      onClose: async () => {
        this.transition(conversationId, "completed");
        this.emit("session:completed", { sessionId: conversationId });
        try {
          await scanSessions("incremental");
          generateTitleBatch(1).catch(() => {});
        } catch { /* non-critical */ }
      },
    });

    return stream;
  }

  // ── Public API: Forge resume (returns SSE stream) ─────────────────────────

  /**
   * Resume an existing Forge session with a new message.
   * Returns SSE stream (for UI-initiated replies).
   */
  resumeForge(conversationId: string, message: string, projectPath: string, model?: string): ReadableStream {
    const { createForgeSSEStream } = require("./forge-runner") as typeof import("./forge-runner");

    this.queue.cancel(`stall_continue:${conversationId}`);

    this.states.set(conversationId, {
      sessionId: conversationId,
      phase: "running",
      projectPath,
      pid: null,
      retryCount: this.states.get(conversationId)?.retryCount ?? 0,
      skipCount: this.states.get(conversationId)?.skipCount ?? 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    });

    logAction("service", "forge_resume", `msg_len:${message.length}`, conversationId);
    this.emit("session:resumed", { sessionId: conversationId, projectPath });

    return createForgeSSEStream({
      conversationId,
      message,
      projectPath,
      model,
      onClose: async () => {
        this.transition(conversationId, "completed");
        this.emit("session:completed", { sessionId: conversationId });
        try { await scanSessions("incremental"); } catch { /* non-critical */ }
      },
    });
  }

  // ── Public API: Forge resume fire-and-forget (babysitter) ────────────────

  /**
   * Resume a Forge session in the background (no SSE stream returned).
   * Used by the babysitter stall detection.
   */
  resumeForgeBackground(conversationId: string, message: string, projectPath: string, model?: string): void {
    const state = this.states.get(conversationId);
    if (state && !["idle", "completed", "failed"].includes(state.phase)) return;

    const { getForgePath } = require("./forge-bin") as typeof import("./forge-bin");
    const { getCleanEnv } = require("./utils") as typeof import("./utils");
    const { spawnSync } = require("child_process") as typeof import("child_process");

    this.states.set(conversationId, {
      sessionId: conversationId,
      phase: "running",
      projectPath,
      pid: null,
      retryCount: 0,
      skipCount: 0,
      lastActivity: Date.now(),
      startedAt: Date.now(),
    });

    logAction("service", "forge_stall_continue", projectPath, conversationId);

    // Set model if provided
    if (model) {
      spawnSync(getForgePath(), ["config", "set", "model", model], {
        env: getCleanEnv(),
        stdio: "ignore",
      });
    }

    // Rotate Gemini key before spawning (checks quota, writes working key to ~/forge/.credentials.json)
    if (process.platform !== "win32") {
      const rotatePath = `${process.env.HOME}/.claude/scripts/pm-gemini-rotate.sh`;
      const rotateResult = spawnSync("bash", [rotatePath], {
        env: getCleanEnv(),
        encoding: "utf-8",
        timeout: 35_000,
      });
      if (rotateResult.status !== 0) {
        logAction("service", "forge_stall_continue_skipped", "all Gemini keys exhausted", conversationId);
        this.transition(conversationId, "failed", "all Gemini keys exhausted");
        return;
      }
    }

    const proc = spawn(getForgePath(), [
      "--conversation-id", conversationId,
      "-C", projectPath,
      "-p", message,
    ], {
      cwd: projectPath,
      env: getCleanEnv(),
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    proc.unref();

    proc.on("close", async () => {
      this.transition(conversationId, "completed");
      try { await scanSessions("incremental"); } catch { /* non-critical */ }
    });
  }

  // ── Public API: stop ──────────────────────────────────────────────────────

  /**
   * Stop (kill) a running session.
   */
  stop(sessionId: string): { killed: number; pids: number[] } {
    this.queue.cancelForSession(sessionId);
    const pids = killSessionProcesses(sessionId);
    this.transition(sessionId, "idle");
    this.emit("session:stopped", { sessionId, pids });
    logAction("service", "kill_terminal", `pids:${pids.join(",")}`, sessionId);
    return { killed: pids.length, pids };
  }

  // ── Public API: status ────────────────────────────────────────────────────

  status(sessionId: string): SessionState | null {
    return this.states.get(sessionId) ?? null;
  }

  getAllStates(): SessionState[] {
    return [...this.states.values()];
  }

  getQueueStatus(): QueueStatus {
    return this.queue.getStatus();
  }

  // ── Enqueue: crash retry ──────────────────────────────────────────────────

  enqueueCrashRetry(sessionId: string, jsonlPath: string): boolean {
    const delayMs = parseInt(getSetting("orchestrator_crash_retry_delay_ms") || "30000", 10);

    if (detectPermissionLoop(jsonlPath)) {
      logAction("service", "permission_loop_detected", `jsonl:${jsonlPath}`, sessionId);
      return this.enqueuePermissionEscalation(sessionId);
    }

    this.transition(sessionId, "crashed");
    this.emit("session:crashed", { sessionId });

    return this.queue.add({
      id: `crash_retry:${sessionId}`,
      sessionId,
      type: "crash_retry",
      priority: "high",
      delayMs,
      scheduledAt: Date.now(),
      execute: () => this.executeCrashRetry(sessionId),
    });
  }

  // ── Enqueue: stall continue ───────────────────────────────────────────────

  enqueueStallContinue(sessionId: string): boolean {
    const delayMs = parseInt(getSetting("orchestrator_stall_continue_delay_ms") || "10000", 10);

    this.transition(sessionId, "stalled");
    this.emit("session:stalled", { sessionId });

    return this.queue.add({
      id: `stall_continue:${sessionId}`,
      sessionId,
      type: "stall_continue",
      priority: "low",
      delayMs,
      scheduledAt: Date.now(),
      execute: () => this.executeStallContinue(sessionId),
    });
  }

  // ── Enqueue: incomplete exit resume ──────────────────────────────────────
  // Claude said "I'll do X" then process died. Not a crash (tool_result) and
  // not a stall (process alive). This is the "dead zone" between the two.

  enqueueIncompleteExitResume(sessionId: string, jsonlPath: string): boolean {
    const delayMs = parseInt(getSetting("orchestrator_crash_retry_delay_ms") || "30000", 10);

    this.transition(sessionId, "crashed");
    this.emit("session:crashed", { sessionId });

    return this.queue.add({
      id: `incomplete_exit:${sessionId}`,
      sessionId,
      type: "incomplete_exit",
      priority: "normal",
      delayMs,
      scheduledAt: Date.now(),
      execute: () => this.executeIncompleteExitResume(sessionId, jsonlPath),
    });
  }

  // ── Enqueue: permission escalation ────────────────────────────────────────

  enqueuePermissionEscalation(sessionId: string): boolean {
    return this.queue.add({
      id: `permission_escalation:${sessionId}`,
      sessionId,
      type: "permission_escalation",
      priority: "high",
      delayMs: 15_000,
      scheduledAt: Date.now(),
      execute: () => this.executePermissionEscalation(sessionId),
    });
  }

  // ── Enqueue: permission wait (session blocked on stdin for tool approval) ──

  enqueuePermissionWait(sessionId: string): boolean {
    return this.queue.add({
      id: `permission_wait:${sessionId}`,
      sessionId,
      type: "permission_escalation",
      priority: "high",
      delayMs: 5_000, // short delay — we already waited 2+ min for detection
      scheduledAt: Date.now(),
      execute: () => this.executePermissionWait(sessionId),
    });
  }

  // ── Generic enqueue (for API endpoint) ────────────────────────────────────

  enqueue(params: {
    sessionId: string;
    type: TaskType;
    message?: string;
    priority?: TaskPriority;
    delayMs?: number;
  }): string {
    const { sessionId, type, message, priority = "normal", delayMs = 0 } = params;
    const taskId = `${type}:${sessionId}`;

    switch (type) {
      case "start":
      case "resume": {
        if (!message) throw new Error("message required for start/resume");
        this.queue.add({
          id: taskId,
          sessionId,
          type,
          priority,
          delayMs,
          scheduledAt: Date.now(),
          execute: async () => {
            const db = getDb();
            const session = db
              .prepare("SELECT project_path FROM sessions WHERE session_id = ?")
              .get(sessionId) as { project_path: string } | undefined;
            if (!session) throw new Error(`Session ${sessionId} not found`);

            // Fire-and-forget (no SSE consumer)
            const args = buildCliArgs({ sessionId, message, includeMaxTurns: true });
            const proc = spawn(getClaudePath(), args, {
              cwd: session.project_path,
              env: getCleanEnv(),
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
              windowsHide: true,
            });
            proc.stdout?.resume();
            proc.stderr?.resume();
            proc.unref();
            proc.on("close", (code) => {
              logAction("service", code === 0 ? "enqueued_task_done" : "enqueued_task_failed", `exit:${code}`, sessionId);
              this.transition(sessionId, "completed");
            });
            logAction("service", "enqueued_task_fired", type, sessionId);
          },
        });
        break;
      }
      case "crash_retry":
        this.queue.add({
          id: taskId, sessionId, type,
          priority: priority || "high",
          delayMs: delayMs || 30_000,
          scheduledAt: Date.now(),
          execute: () => this.executeCrashRetry(sessionId),
        });
        break;
      case "stall_continue":
        this.queue.add({
          id: taskId, sessionId, type,
          priority: priority || "low",
          delayMs: delayMs || 10_000,
          scheduledAt: Date.now(),
          execute: () => this.executeStallContinue(sessionId),
        });
        break;
      case "incomplete_exit": {
        const db2 = getDb();
        const sess = db2
          .prepare("SELECT jsonl_path FROM sessions WHERE session_id = ?")
          .get(sessionId) as { jsonl_path: string } | undefined;
        if (sess) {
          this.enqueueIncompleteExitResume(sessionId, sess.jsonl_path);
        }
        break;
      }
      case "permission_escalation":
        this.enqueuePermissionEscalation(sessionId);
        break;
      case "permission_wait":
        this.enqueuePermissionWait(sessionId);
        break;
    }

    this.emit("task:queued", { taskId, type, priority, sessionId });
    return taskId;
  }

  // ── Private: execution methods ────────────────────────────────────────────

  private async executeCrashRetry(sessionId: string): Promise<void> {
    const db = getDb();
    const session = db
      .prepare("SELECT project_path, last_message_role, last_message, first_prompt, jsonl_path FROM sessions WHERE session_id = ?")
      .get(sessionId) as Pick<SessionRow, "project_path" | "last_message_role" | "jsonl_path"> & { last_message: string | null; first_prompt: string | null } | undefined;

    if (!session || session.last_message_role !== "tool_result") return;
    if (getSetting("auto_retry_on_crash") === "false") return;

    // If the process is still alive, it recovered on its own — skip
    if (isSessionActive(sessionId)) {
      logAction("service", "auto_retry_skipped", "process alive — recovered before execution", sessionId);
      this.transition(sessionId, "running");
      return;
    }

    // Detect babysitter loop — if we've already poked this session 2+ times, stop
    const loop = detectBabysitterLoop(session.jsonl_path);
    if (loop.unproductiveCount >= 2 || loop.resumes >= 4) {
      logAction("service", "auto_retry_skipped", `babysitter loop: ${loop.unproductiveCount} unproductive / ${loop.resumes} total resumes`, sessionId);
      this.transition(sessionId, "failed", "babysitter loop");
      return;
    }

    // Check if the assistant message BEFORE the crash was a completion message.
    // If Claude said "всё готово" and then crashed on a final verification tool call,
    // retrying is unnecessary — the task was already done.
    const lastAssistantText = extractLastAssistantText(session.jsonl_path);
    if (lastAssistantText) {
      const lower = lastAssistantText.toLowerCase();
      const completionPatterns = [
        /\b(all done|all set|task (is |has been )?complet|that'?s it)\b/,
        /\b(here('s| is| are) (the |your |a )?(final|complete|full|result|summary|output))\b/,
        /\bsuccessfully (deployed|published|created|updated|completed|finished|built|pushed)\b/,
        /\b(everything is|changes are|all changes|code is|build is|deploy is) (now |)(done|ready|live|complete|deployed)\b/,
        /готово|завершен|опубликовано|задач[аи] выполнен|всё сделано|все изменения|полностью готов|готово к работе|готов к запуску/,
        /жду(?=[\s.,!?]|$)|когда скажешь|можешь (запуск|открыва|проверя)/,
      ];
      if (completionPatterns.some((re) => re.test(lower))) {
        logAction("service", "auto_retry_skipped", `task was completed before crash: "${lastAssistantText.slice(0, 80)}"`, sessionId);
        this.transition(sessionId, "completed");
        return;
      }
    }

    const maxRetries = parseInt(getSetting("orchestrator_max_retries") || "3", 10);
    const state = this.states.get(sessionId);
    if (state && state.retryCount >= maxRetries) {
      this.transition(sessionId, "failed", `max retries (${maxRetries}) exceeded`);
      this.emit("session:failed", { sessionId, reason: "max_retries" });
      logAction("service", "auto_retry_max_exceeded", `retries:${state.retryCount}`, sessionId);
      return;
    }

    this.transition(sessionId, "retrying");
    this.emit("session:retrying", { sessionId, attempt: (state?.retryCount ?? 0) + 1 });
    logAction("service", "auto_retry_fired", "orchestrator", sessionId);

    const taskContext = session.first_prompt
      ? `\n\nOriginal task: "${session.first_prompt.slice(0, 300)}"`
      : "";
    const userContext = session.last_message
      ? `\nUser's last message: "${session.last_message.slice(0, 200)}"`
      : "";
    const retryPrompt = `You crashed mid-tool-execution. Continue where you left off — do NOT summarize what happened, just keep working.${taskContext}${userContext}`;

    const args = buildCliArgs({ sessionId, message: retryPrompt, includeMaxTurns: true });
    const proc = spawn(
      getClaudePath(),
      args,
      { cwd: session.project_path, env: getCleanEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    proc.stdout?.resume();
    proc.stderr?.resume();

    if (state) {
      state.retryCount++;
      state.pid = proc.pid ?? null;
    }

    return new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        logAction("service", code === 0 ? "auto_retry_done" : "auto_retry_failed", `exit:${code}`, sessionId);
        this.transition(sessionId, code === 0 ? "running" : "crashed");
        resolve();
      });
    });
  }

  private async executeStallContinue(sessionId: string): Promise<void> {
    const db = getDb();
    const session = db
      .prepare("SELECT project_path, last_message_role, last_message, jsonl_path, first_prompt, has_result FROM sessions WHERE session_id = ?")
      .get(sessionId) as Pick<SessionRow, "project_path" | "last_message_role" | "jsonl_path" | "has_result"> & { last_message: string | null; first_prompt: string | null } | undefined;

    if (!session) return;
    if (getSetting("auto_continue_on_stall") !== "true") return;

    // Skip if Claude completed the turn normally — process alive means waiting for user, not stalled
    if (session.has_result) return;

    // Direct JSONL check: last event is a result → Claude just finished, waiting for user
    if (isLastEventResult(session.jsonl_path)) return;

    // Skip if session is already running (user sent a reply while we were waiting)
    const currentPhase = this.states.get(sessionId)?.phase;
    if (currentPhase === "running" || currentPhase === "continuing") return;

    // Detect babysitter loop
    const loop = detectBabysitterLoop(session.jsonl_path);
    if (loop.unproductiveCount >= 2 || loop.resumes >= 4) {
      logAction("service", "stall_continue_skipped", `babysitter loop: ${loop.unproductiveCount} unproductive / ${loop.resumes} total resumes`, sessionId);
      this.transition(sessionId, "failed", "babysitter loop");
      return;
    }
    if (!isSessionActive(sessionId)) return;

    try {
      const mtime = fs.statSync(session.jsonl_path).mtimeMs;
      if (Date.now() - mtime < STALL_THRESHOLD_MS) return;
    } catch { return; }

    if (session.last_message_role !== "assistant") return;

    const lastAssistantText = extractLastAssistantText(session.jsonl_path);
    const waiting = await isWaitingForUser(lastAssistantText);
    const stState = this.states.get(sessionId);
    const stSkips = stState?.skipCount ?? 0;
    const MAX_STALL_SKIPS = 3;

    if (waiting && stSkips < MAX_STALL_SKIPS) {
      if (stState) {
        stState.skipCount++;
      } else {
        this.states.set(sessionId, {
          sessionId, phase: "idle", projectPath: session.project_path,
          pid: null, retryCount: 0, skipCount: 1,
          lastActivity: Date.now(), startedAt: Date.now(),
        });
      }
      logAction("service", "stall_continue_skipped", `Claude is asking user a question (skip ${stSkips + 1}/${MAX_STALL_SKIPS})`, sessionId);
      this.transition(sessionId, "idle");
      return;
    }
    if (waiting && stSkips >= MAX_STALL_SKIPS) {
      logAction("service", "stall_continue_force_resume", `skipped ${stSkips} times, forcing resume`, sessionId);
    }

    this.transition(sessionId, "continuing");
    this.emit("session:continuing", { sessionId });
    logAction("service", "stall_continue_fired", `stalled >${STALL_THRESHOLD_MS / 60_000}min`, sessionId);

    const taskContext = session.first_prompt
      ? `\n\nOriginal task: "${session.first_prompt.slice(0, 300)}"`
      : "";
    const userContext = session.last_message
      ? `\nUser's last message: "${session.last_message.slice(0, 200)}"`
      : "";
    const stallPrompt = `You stalled — no output for over 5 minutes. Continue where you left off. Do NOT summarize what happened, just keep working on the task.${taskContext}${userContext}`;

    const args = buildCliArgs({ sessionId, message: stallPrompt, includeMaxTurns: true });
    const proc = spawn(
      getClaudePath(),
      args,
      { cwd: session.project_path, env: getCleanEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    proc.stdout?.resume();
    proc.stderr?.resume();

    return new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        logAction("service", code === 0 ? "stall_continue_done" : "stall_continue_failed", `exit:${code}`, sessionId);
        this.transition(sessionId, code === 0 ? "running" : "idle");
        resolve();
      });
    });
  }

  private async executeIncompleteExitResume(sessionId: string, jsonlPath: string): Promise<void> {
    const db = getDb();
    const session = db
      .prepare("SELECT project_path, last_message_role, last_message, jsonl_path, first_prompt FROM sessions WHERE session_id = ?")
      .get(sessionId) as Pick<SessionRow, "project_path" | "last_message_role" | "jsonl_path"> & { last_message: string | null; first_prompt: string | null } | undefined;

    if (!session) return;
    if (getSetting("auto_retry_on_crash") === "false") return;

    // Detect babysitter loop — stop if unproductive resumes or too many total
    const loop = detectBabysitterLoop(session.jsonl_path);
    if (loop.unproductiveCount >= 2 || loop.resumes >= 4) {
      logAction("service", "incomplete_exit_skipped", `babysitter loop: ${loop.unproductiveCount} unproductive / ${loop.resumes} total resumes`, sessionId);
      this.transition(sessionId, "failed", "babysitter loop");
      return;
    }

    // Skip if session actually completed normally (has result event in JSONL)
    if (hasResultEvent(session.jsonl_path)) {
      logAction("service", "incomplete_exit_skipped", "session has result event (completed normally)", sessionId);
      this.transition(sessionId, "completed");
      return;
    }

    // Double-check: process must be dead and last message must be assistant
    if (isSessionActive(sessionId)) return;
    if (session.last_message_role !== "assistant") return;

    // KEY HEURISTIC: If the last assistant message is text-only (no tool_use),
    // Claude finished speaking and wasn't waiting for tool results.
    // The process should have exited normally. Resuming text-only exits
    // is almost always a false positive ("всё работает", "жду команды", etc.)
    if (!lastAssistantHasToolUse(session.jsonl_path)) {
      const lastText = extractLastAssistantText(session.jsonl_path);
      logAction("service", "incomplete_exit_skipped", `text-only last message (no tool_use): "${lastText.slice(0, 80)}"`, sessionId);
      this.transition(sessionId, "completed");
      return;
    }

    // Check if Claude was actually asking a question (don't auto-resume questions)
    const lastAssistantText = extractLastAssistantText(session.jsonl_path);
    const waiting = await isWaitingForUser(lastAssistantText, "incomplete_exit");
    const state0 = this.states.get(sessionId);
    const skipsSoFar = state0?.skipCount ?? 0;
    const MAX_SKIPS = 3; // after 3 skips, force-resume regardless
    if (waiting && skipsSoFar < MAX_SKIPS) {
      // Track repeated skips — if we keep skipping the same session, eventually force it
      if (state0) {
        state0.skipCount++;
      } else {
        this.states.set(sessionId, {
          sessionId, phase: "idle", projectPath: session.project_path,
          pid: null, retryCount: 0, skipCount: 1,
          lastActivity: Date.now(), startedAt: Date.now(),
        });
      }
      logAction("service", "incomplete_exit_skipped", `Claude was asking a question (skip ${skipsSoFar + 1}/${MAX_SKIPS})`, sessionId);
      this.transition(sessionId, "idle");
      return;
    }
    if (waiting && skipsSoFar >= MAX_SKIPS) {
      logAction("service", "incomplete_exit_force_resume", `skipped ${skipsSoFar} times, forcing resume`, sessionId);
    }

    const maxRetries = parseInt(getSetting("orchestrator_max_retries") || "3", 10);
    const state = this.states.get(sessionId);
    if (state && state.retryCount >= maxRetries) {
      this.transition(sessionId, "failed", `max retries (${maxRetries}) exceeded`);
      this.emit("session:failed", { sessionId, reason: "max_retries" });
      logAction("service", "incomplete_exit_max_exceeded", `retries:${state.retryCount}`, sessionId);
      return;
    }

    this.transition(sessionId, "retrying");
    this.emit("session:retrying", { sessionId, attempt: (state?.retryCount ?? 0) + 1 });
    logAction("service", "incomplete_exit_fired", "orchestrator", sessionId);

    const taskContext = session.first_prompt
      ? `\n\nOriginal task: "${session.first_prompt.slice(0, 300)}"`
      : "";
    const userContext = session.last_message
      ? `\nUser's last message: "${session.last_message.slice(0, 200)}"`
      : "";
    const resumePrompt = `Your process exited unexpectedly. You were mid-task when it died. Continue where you left off — do NOT summarize what happened, just keep working.${taskContext}${userContext}`;

    const args = buildCliArgs({ sessionId, message: resumePrompt, includeMaxTurns: true });
    const proc = spawn(
      getClaudePath(),
      args,
      { cwd: session.project_path, env: getCleanEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    proc.stdout?.resume();
    proc.stderr?.resume();

    if (state) {
      state.retryCount++;
      state.pid = proc.pid ?? null;
    }

    return new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        logAction("service", code === 0 ? "incomplete_exit_done" : "incomplete_exit_failed", `exit:${code}`, sessionId);
        this.transition(sessionId, code === 0 ? "completed" : "crashed");
        resolve();
      });
    });
  }

  private async executePermissionWait(sessionId: string): Promise<void> {
    const db = getDb();
    const session = db
      .prepare("SELECT project_path, jsonl_path, last_message FROM sessions WHERE session_id = ?")
      .get(sessionId) as { project_path: string; jsonl_path: string; last_message: string | null } | undefined;

    if (!session) return;
    if (getSetting("auto_escalate_permissions") === "false") return;

    // Re-check: still looks like a permission wait? (skip re-check for test word triggers)
    const testWord = getSetting("permission_escalation_test_word");
    const isTestTrigger = testWord && testWord.length > 3 && detectTestWordInLastAssistant(session.jsonl_path, testWord);
    if (!isTestTrigger && !detectPermissionWait(session.jsonl_path)) {
      dlog.info("orchestrator", `permission_wait for ${sessionId}: no longer waiting, skipping`);
      return;
    }

    // Still alive? Kill the stuck process
    if (isSessionActive(sessionId)) {
      logAction("service", "permission_wait_killing", `session stuck on tool approval`, sessionId);
      killSessionProcesses(sessionId);
      // Wait for process to die and release locks
      await new Promise((r) => setTimeout(r, 3000));
    }

    this.transition(sessionId, "retrying");
    this.emit("session:retrying", { sessionId, reason: "permission_wait" });
    logAction("service", "permission_wait_fired", "kill+open in terminal with skip-permissions", sessionId);

    // Open in terminal — visible to user, reliable
    const claudePath = getClaudePath();
    const shellCmd = `cd ${JSON.stringify(session.project_path)} && ${claudePath} --resume ${sessionId} --dangerously-skip-permissions -p "You were waiting for tool permission approval but nobody was there to approve. I've restarted you with full permissions. Continue your task where you left off."`;

    try {
      const autoClose = getSetting("auto_close_escalation_terminals") !== "false";
      const { terminal } = await openInTerminal(shellCmd, { autoClose });
      logAction("service", "permission_wait_done", `terminal:${terminal}${autoClose ? ",autoClose" : ""}`, sessionId);
      this.transition(sessionId, "running");
    } catch (err) {
      logAction("service", "permission_wait_failed", `${err}`, sessionId);
      this.transition(sessionId, "crashed");
    }
  }

  private async executePermissionEscalation(sessionId: string): Promise<void> {
    const db = getDb();
    const session = db
      .prepare("SELECT project_path, jsonl_path FROM sessions WHERE session_id = ?")
      .get(sessionId) as { project_path: string; jsonl_path: string } | undefined;

    if (!session) return;
    if (getSetting("auto_retry_on_crash") === "false") return;

    if (!detectPermissionLoop(session.jsonl_path)) {
      await this.executeCrashRetry(sessionId);
      return;
    }

    logAction("service", "permission_escalation_fired", "pushing to terminal", sessionId);

    const claudePath = getClaudePath();
    const shellCmd = `cd ${JSON.stringify(session.project_path)} && ${claudePath} --resume ${sessionId} --dangerously-skip-permissions -p "check access again please"`;

    try {
      const autoClose = getSetting("auto_close_escalation_terminals") !== "false";
      const { terminal } = await openInTerminal(shellCmd, { autoClose });
      logAction("service", "permission_escalation_done", `terminal:${terminal}${autoClose ? ",autoClose" : ""}`, sessionId);
    } catch (err) {
      logAction("service", "permission_escalation_failed", `${err}`, sessionId);
    }
  }

  // ── State transitions ─────────────────────────────────────────────────────

  private transition(sessionId: string, phase: SessionPhase, error?: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.phase = phase;
      state.lastActivity = Date.now();
      if (error) state.error = error;
      // Auto-notify parent when a delegated session permanently fails
      if (phase === "failed" && state.replyToSessionId) {
        this.notifyDelegationFailed(sessionId, state.replyToSessionId, error || "session failed")
          .catch(() => {});
      }
    }
  }

  /** Send a FAILED reply to the parent session when the delegated child gives up. */
  private async notifyDelegationFailed(childId: string, parentId: string, reason: string): Promise<void> {
    try {
      const db = getDb();
      const row = db.prepare(
        "SELECT delegation_task, delegation_status FROM sessions WHERE session_id = ?"
      ).get(childId) as { delegation_task: string | null; delegation_status: string | null } | undefined;
      if (!row || row.delegation_status !== "pending") return;

      db.prepare("UPDATE sessions SET delegation_status = 'failed' WHERE session_id = ?").run(childId);

      const parent = db.prepare("SELECT project_path FROM sessions WHERE session_id = ?")
        .get(parentId) as { project_path: string } | undefined;
      if (!parent) return;

      const failMsg = `DELEGATION FAILED: Sub-session ${childId} could not complete the task "${row.delegation_task || "delegated task"}". Reason: ${reason}`;
      logAction("service", "delegation_failed_notified", `child:${childId} reason:${reason}`, parentId);
      this.enqueue({ sessionId: parentId, type: "resume", message: failMsg, priority: "high" });
    } catch { /* non-critical */ }
  }

  /**
   * Periodic check for sessions stuck waiting for tool permission approval.
   * Runs independently of scan — fixes the gap where scan skips frozen-mtime files.
   * Queries DB for candidates, checks process liveness + JSONL content.
   */
  private periodicPermissionCheck(): void {
    try {
      if (getSetting("auto_escalate_permissions") === "false") return;

      const db = getDb();
      const permWaitMs = parseInt(
        getSetting("permission_wait_threshold_ms") || String(PERMISSION_WAIT_THRESHOLD_MS),
        10
      );
      const cutoff = Date.now() - permWaitMs;
      const maxAge = Date.now() - 30 * 60 * 1000; // ignore sessions older than 30 min

      // Find sessions where: assistant spoke last, no result, file is frozen > threshold
      const candidates = db.prepare(`
        SELECT session_id, jsonl_path, file_mtime
        FROM sessions
        WHERE last_message_role = 'assistant'
          AND has_result = 0
          AND file_mtime < ?
          AND file_mtime > ?
      `).all(cutoff, maxAge) as Array<{
        session_id: string;
        jsonl_path: string;
        file_mtime: number;
      }>;

      for (const session of candidates) {
        // Skip if orchestrator already handling this session
        const state = this.status(session.session_id);
        if (state && !["idle", "completed", "failed"].includes(state.phase)) continue;

        // Must be alive (stuck on stdin) — dead processes are handled by detectIncompleteExits
        if (!isSessionActive(session.session_id)) continue;

        // Check JSONL: last assistant message must have tool_use with no subsequent tool_result
        const testWord = getSetting("permission_escalation_test_word");
        const isTestTrigger = testWord && testWord.length > 3 &&
          detectTestWordInLastAssistant(session.jsonl_path, testWord);

        if (!detectPermissionWait(session.jsonl_path) && !isTestTrigger) continue;

        const silentMin = Math.round((Date.now() - session.file_mtime) / 60_000);
        dlog.info("orchestrator", `periodic permission check: ${session.session_id} stuck ${silentMin}min`);
        logAction("service", "permission_wait_detected", `periodic check, silent:${silentMin}min`, session.session_id);
        this.enqueuePermissionWait(session.session_id);
      }
    } catch (err) {
      dlog.error("orchestrator", `periodic permission check failed: ${err}`);
    }
  }

  private cleanupStaleStates(): void {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour for completed/failed/idle
    const runningCutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 hours for running
    const transientCutoff = Date.now() - 30 * 60 * 1000; // 30 min for transient phases
    for (const [id, state] of this.states) {
      if (
        (state.phase === "completed" || state.phase === "failed" || state.phase === "idle") &&
        state.lastActivity < cutoff
      ) {
        this.states.delete(id);
      } else if (
        state.phase === "running" &&
        state.lastActivity < runningCutoff &&
        !isSessionActive(id)
      ) {
        // Running state stuck for >2 hours with dead process — clean up
        dlog.warn("orchestrator", `cleaning up stale running state for ${id} (last activity ${Math.round((Date.now() - state.lastActivity) / 60_000)}min ago)`);
        this.states.delete(id);
      } else if (
        (state.phase === "crashed" || state.phase === "retrying" ||
         state.phase === "stalled" || state.phase === "continuing") &&
        state.lastActivity < transientCutoff
      ) {
        // Transient phases stuck for >30 min — they should have resolved by now
        dlog.warn("orchestrator", `cleaning up stuck ${state.phase} state for ${id} (last activity ${Math.round((Date.now() - state.lastActivity) / 60_000)}min ago)`);
        this.states.delete(id);
      }
    }

    // Prune old actions_log rows (keep last 7 days)
    try {
      const { getDb } = require("./db");
      const deleted = getDb()
        .prepare("DELETE FROM actions_log WHERE created_at < datetime('now', '-7 days')")
        .run();
      if (deleted.changes > 0) {
        dlog.info("orchestrator", `pruned ${deleted.changes} old actions_log rows`);
        // Vacuum occasionally if rows were deleted
        if (Math.random() < 0.1) {
          getDb().exec("VACUUM; ANALYZE;");
        }
      }
    } catch { /* non-critical */ }

    // Clean up stale offline workers
    try {
      const { getWorkerRegistry } = require("./worker-registry");
      getWorkerRegistry().cleanupStaleWorkers();
    } catch { /* non-critical */ }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.permissionCheckTimer) {
      clearInterval(this.permissionCheckTimer);
      this.permissionCheckTimer = null;
    }
  }
}

// ── Singleton (survives Next.js hot reload via globalThis) ───────────────────

const GLOBAL_KEY = "__sessionOrchestrator";

export function getOrchestrator(): SessionOrchestrator {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new SessionOrchestrator();
    dlog.info("orchestrator", "initialized");

    // Auto-start relay client if enabled
    try {
      initRelayIfEnabled();
    } catch (err) {
      dlog.error("orchestrator", `relay init failed: ${err}`);
    }

    // Wire worker registry fallback
    try {
      const { getWorkerRegistry } = require("./worker-registry");
      const { triggerFallback } = require("./worker-fallback");
      const registry = getWorkerRegistry();
      registry.on("worker:offline", ({ workerId }: { workerId: string }) => {
        triggerFallback(workerId).catch((err: unknown) => {
          dlog.error("orchestrator", `worker fallback failed for ${workerId}: ${err}`);
        });
      });
      dlog.info("orchestrator", "worker registry wired");
    } catch (err) {
      dlog.error("orchestrator", `worker registry init failed: ${err}`);
    }
  }
  return g[GLOBAL_KEY] as SessionOrchestrator;
}

export type { SessionOrchestrator };
