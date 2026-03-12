import { NextRequest } from "next/server";
import { getSetting, logAction } from "@/lib/db";
import { createSSEStream, sseResponse } from "@/lib/claude-runner";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

const PROJECT_DIR = process.cwd();
const REPORTS_DIR = path.join(PROJECT_DIR, "data", "reports");
const DB_PATH = path.join(PROJECT_DIR, "data", "analytics.db");

const DB_SCHEMA = `
-- analytics.db (SQLite, readonly) — 2121 sessions, 221K messages, 78K tool_calls, 321 compacts

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  jsonl_path TEXT, file_size INTEGER,
  project_dir TEXT,        -- e.g. "-Users-vova-Documents-GitHub-candidate-routing"
  project_path TEXT,       -- e.g. "/Users/vova/Documents/GitHub/candidate-routing"
  cwd TEXT, git_branch TEXT, slug TEXT, claude_version TEXT,
  model TEXT,              -- e.g. "claude-opus-4-6", "claude-sonnet-4-6"
  first_prompt TEXT,       -- first user message (full text)
  first_prompt_length INTEGER,
  message_count INTEGER, user_message_count INTEGER, assistant_message_count INTEGER,
  tool_call_count INTEGER, compact_count INTEGER,
  total_input_tokens INTEGER, total_output_tokens INTEGER,
  total_cache_read_tokens INTEGER, total_cache_creation_tokens INTEGER,
  total_thinking_tokens INTEGER,
  is_subagent INTEGER DEFAULT 0,  -- 1 = subagent session
  parent_session_id TEXT,
  started_at TEXT,         -- ISO datetime
  ended_at TEXT,
  duration_seconds REAL,
  parsed_at TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY, session_id TEXT,
  uuid TEXT, parent_uuid TEXT,
  type TEXT,               -- 'user', 'assistant', 'system'
  subtype TEXT,            -- NULL, 'compact_boundary', 'stop_hook_summary', 'turn_duration'
  role TEXT, model TEXT, timestamp TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, thinking_tokens INTEGER,
  stop_reason TEXT,        -- 'end_turn', 'tool_use', etc
  content_length INTEGER,  -- chars in message content
  has_thinking INTEGER, has_tool_use INTEGER, is_sidechain INTEGER,
  line_number INTEGER
);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY, session_id TEXT,
  message_uuid TEXT, tool_name TEXT, tool_use_id TEXT,
  input_json TEXT,         -- tool call arguments as JSON
  is_mcp INTEGER, mcp_server TEXT,
  timestamp TEXT, line_number INTEGER
);

CREATE TABLE compacts (
  id INTEGER PRIMARY KEY, session_id TEXT,
  timestamp TEXT, line_number INTEGER,
  pre_input_tokens INTEGER,   -- context size BEFORE compact
  post_input_tokens INTEGER,  -- context size AFTER compact
  summary_length INTEGER,     -- chars in compact summary
  messages_before INTEGER, messages_after INTEGER
);

CREATE TABLE context_timeline (
  id INTEGER PRIMARY KEY, session_id TEXT,
  timestamp TEXT, cumulative_input_tokens INTEGER,
  cumulative_output_tokens INTEGER, cumulative_cache_read INTEGER,
  message_index INTEGER
);
`.trim();

function buildPrompt(question: string, reportId: string): string {
  const outputPath = path.join(REPORTS_DIR, `${reportId}.html`);
  const scriptPath = path.join(REPORTS_DIR, `${reportId}.py`);

  return `You are an analytics engineer. The user asked this question about their Claude Code usage:

"${question}"

Your job: write a Python script that queries the SQLite database and generates a self-contained HTML report with charts.

## Database
Path: ${DB_PATH}
${DB_SCHEMA}

## Key facts
- project_dir uses dashes: "-Users-vova-Documents-GitHub-myproject". To get readable name: split on "GitHub-" and take last part
- total context = cache_read_tokens + cache_creation_tokens + input_tokens (NOT just input_tokens which shows streaming chunks)
- Filter main sessions with: is_subagent = 0
- Timestamps are ISO format: "2026-03-05T14:30:00Z"

## Requirements

1. Write a Python script to: ${scriptPath}
2. Script must:
   - import sqlite3, produce HTML with embedded Chart.js charts
   - Query ${DB_PATH} (readonly)
   - Save output HTML to: ${outputPath}
   - Print "REPORT_READY:${outputPath}" as the very last line of stdout
3. HTML must be self-contained:
   - Use <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
   - Dark theme: background #0a0a0a, text #e5e5e5, cards with #1a1a1a bg and #2a2a2a borders
   - Charts use these colors: #6366f1, #8b5cf6, #a78bfa, #06b6d4, #10b981, #f59e0b, #ef4444
   - Include a title, key metrics summary, and 1-3 charts
   - Responsive, max-width 900px, clean typography
4. Run the script after writing it
5. Do NOT ask any questions — make reasonable assumptions. If the question is ambiguous, pick the most useful interpretation.
6. Keep it focused: answer the specific question, don't over-analyze

## Output format
Write the script, run it, verify the HTML file exists. That's it.
Do not output anything else after the script runs successfully.`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { question } = body as { question: string };

  if (!question?.trim()) {
    return Response.json({ error: "question required" }, { status: 400 });
  }

  // Ensure reports dir exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const reportId = `report-${Date.now()}`;
  const prompt = buildPrompt(question.trim(), reportId);

  logAction("service", "analytics_generate", question.slice(0, 200), undefined);

  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "15",
  ];
  if (skipPermissions) args.push("--dangerously-skip-permissions");

  let sessionId: string | null = null;
  let reportPath: string | null = null;

  const encoder = new TextEncoder();

  const stream = createSSEStream({
    args,
    cwd: PROJECT_DIR,
    onLine(obj, send) {
      if (!sessionId && (obj.session_id || obj.sessionId)) {
        sessionId = (obj.session_id ?? obj.sessionId) as string;
        send({ type: "session_id", session_id: sessionId });
      }

      if (obj.type === "assistant" && obj.message) {
        const msg = obj.message as { content?: Array<{ type: string; text?: string; name?: string }> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              send({ type: "text", text: block.text });
              // Check for REPORT_READY marker
              if (block.text.includes("REPORT_READY:")) {
                const match = block.text.match(/REPORT_READY:(.+?)(\s|$)/);
                if (match) reportPath = match[1].trim();
              }
            } else if (block.type === "tool_use") {
              send({ type: "status", text: `Running: ${block.name}` });
            }
          }
        }
      } else if (obj.type === "result") {
        const expectedPath = path.join(REPORTS_DIR, `${reportId}.html`);
        const finalPath = reportPath || expectedPath;
        const fileExists = fs.existsSync(finalPath);

        let htmlContent = "";
        if (fileExists) {
          try { htmlContent = fs.readFileSync(finalPath, "utf-8"); } catch { /* */ }
        }

        send({
          type: "report_done",
          reportId,
          reportPath: finalPath,
          htmlAvailable: fileExists,
          html: htmlContent,
          sessionId,
        });
      }
    },
  });

  // Prepend report_id and prompt events before the stream
  const reportIdEvent = `data: ${JSON.stringify({ type: "report_id", reportId })}\n\n`;
  const promptEvent = `data: ${JSON.stringify({ type: "prompt", prompt })}\n\n`;
  const preamble = encoder.encode(reportIdEvent + promptEvent);

  // Create a combined stream: preamble + SSE stream
  const combinedStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(preamble);
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(combinedStream);
}
