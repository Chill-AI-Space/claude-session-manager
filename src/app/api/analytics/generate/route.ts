import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getCleanEnv } from "@/lib/utils";
import { getSetting, logAction } from "@/lib/db";
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
    return new Response(JSON.stringify({ error: "question required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Ensure reports dir exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const reportId = `report-${Date.now()}`;
  const prompt = buildPrompt(question.trim(), reportId);

  const env = getCleanEnv();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "15",
      ];
      if (skipPermissions) args.push("--dangerously-skip-permissions");

      const proc = spawn("claude", args, {
        cwd: PROJECT_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let sessionId: string | null = null;
      let buffer = "";
      let reportPath: string | null = null;

      logAction("service", "analytics_generate", question.slice(0, 200), undefined);

      // Send report ID and prompt immediately
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "report_id", reportId })}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "prompt", prompt })}\n\n`
        )
      );

      proc.stdout!.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);

            if (!sessionId && (obj.session_id || obj.sessionId)) {
              sessionId = obj.session_id ?? obj.sessionId;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "session_id", session_id: sessionId })}\n\n`
                )
              );
            }

            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "text", text: block.text })}\n\n`
                    )
                  );
                  // Check for REPORT_READY marker in text
                  if (block.text.includes("REPORT_READY:")) {
                    const match = block.text.match(/REPORT_READY:(.+?)(\s|$)/);
                    if (match) reportPath = match[1].trim();
                  }
                } else if (block.type === "tool_use") {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "status", text: `Running: ${block.name}` })}\n\n`
                    )
                  );
                }
              }
            } else if (obj.type === "result") {
              // Check if report file exists
              const expectedPath = path.join(REPORTS_DIR, `${reportId}.html`);
              const fileExists = fs.existsSync(reportPath || expectedPath);
              const finalPath = reportPath || expectedPath;

              let htmlContent = "";
              if (fileExists) {
                try {
                  htmlContent = fs.readFileSync(finalPath, "utf-8");
                } catch { /* */ }
              }

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "report_done",
                    reportId,
                    reportPath: finalPath,
                    htmlAvailable: fileExists,
                    html: htmlContent,
                    sessionId,
                  })}\n\n`
                )
              );
            }
          } catch {
            // skip non-JSON
          }
        }
      });

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString();
        if (!text.includes("Warning:")) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", text })}\n\n`)
          );
        }
      });

      // Keepalive
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 15_000);

      proc.on("close", () => {
        clearInterval(keepalive);
        controller.close();
      });

      proc.on("error", (err) => {
        clearInterval(keepalive);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`)
        );
        controller.close();
      });
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
