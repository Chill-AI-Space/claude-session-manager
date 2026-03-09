import { getDb } from "./db";
import { spawn } from "child_process";
import { pathTail, SPAWN_SHELL } from "./utils";

interface SessionForTitle {
  session_id: string;
  first_prompt: string | null;
  last_message: string | null;
  project_path: string;
  message_count: number;
}

function runClaude(prompt: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "text"],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: SPAWN_SHELL,
      }
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutHandle = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Timeout generating titles"));
    }, 90_000);

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

import { getCleanEnv } from "./utils";

/**
 * Generate titles for a batch of sessions. Returns number generated.
 */
export async function generateTitleBatch(
  limit: number = 20,
  force: boolean = false
): Promise<{ generated: number; total: number }> {
  const db = getDb();

  // Re-title every 6 messages (~3 exchanges) since last title was generated
  const RETITLE_INTERVAL = 6;

  const whereClause = force
    ? "WHERE first_prompt IS NOT NULL"
    : `WHERE first_prompt IS NOT NULL
       AND (generated_title IS NULL
            OR message_count >= COALESCE(titled_at_count, 0) + ${RETITLE_INTERVAL})`;

  const sessions = db
    .prepare(
      `SELECT session_id, first_prompt, last_message, project_path, message_count
       FROM sessions ${whereClause}
       ORDER BY modified_at DESC LIMIT ?`
    )
    .all(limit) as SessionForTitle[];

  if (sessions.length === 0) {
    return { generated: 0, total: 0 };
  }

  const env = getCleanEnv();

  const sessionsText = sessions
    .map((s, i) => {
      const project = pathTail(s.project_path) || "unknown";
      const last = (s.last_message || "").slice(0, 300).replace(/\n/g, " ").replace(/"/g, "'");
      const first = (s.first_prompt || "").slice(0, 120).replace(/\n/g, " ").replace(/"/g, "'");
      return `[${i}] project=${project} | recent: ${last} | started_with: ${first}`;
    })
    .join("\n");

  const prompt = `Generate a short descriptive title (5-10 words, no quotes) for each Claude Code session.
Weight RECENT activity most heavily — the title should reflect what was accomplished at the END of the session, not just how it started. Only fall back to "started_with" if "recent" is ambiguous.
Reply with ONLY numbered lines like:
[0] Title here
[1] Another title

${sessionsText}`;

  const stdout = await runClaude(prompt, env);

  const updateStmt = db.prepare(
    "UPDATE sessions SET generated_title = ?, titled_at_count = ? WHERE session_id = ?"
  );

  let generated = 0;
  const lines = stdout.split("\n");

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (!match) continue;

    const idx = parseInt(match[1]);
    const title = match[2].trim().replace(/^["']|["']$/g, "");

    if (idx >= 0 && idx < sessions.length && title.length > 2) {
      updateStmt.run(title, sessions[idx].message_count, sessions[idx].session_id);
      generated++;
    }
  }

  return { generated, total: sessions.length };
}

// Concurrency guard — only one chain at a time
let titleGenerationRunning = false;

/**
 * Generate all missing titles in batches. Skips if already running.
 */
export async function generateAllMissingTitles(): Promise<void> {
  if (titleGenerationRunning) return;
  titleGenerationRunning = true;
  try {
    for (let i = 0; i < 25; i++) {
      try {
        const { generated } = await generateTitleBatch(20);
        if (generated === 0) break;
      } catch {
        break;
      }
    }
  } finally {
    titleGenerationRunning = false;
  }
}
