import { getDb } from "./db";
import { pathTail } from "./utils";
import { runClaudeOneShot } from "./claude-runner";

interface SessionForTitle {
  session_id: string;
  first_prompt: string | null;
  last_message: string | null;
  project_path: string;
  message_count: number;
}

// Titles from the prompt examples that should never be saved
const EXAMPLE_TITLES = new Set(["title here", "another title"]);

/**
 * Strip <context> preamble so Haiku sees actual content, not the forwarded header.
 */
function stripContextPreamble(text: string): string {
  return text
    .replace(/^<context>\s*/i, "")
    .replace(/^Relevant context from previous session:\s*/i, "")
    .replace(/^USER:\s*<context>\s*/i, "")
    .replace(/^Relevant context from previous session:\s*/i, "")
    .trim();
}

// Concurrency guard — only one title generation call at a time
let titleGenerationRunning = false;

/**
 * Generate titles for a batch of sessions. Returns number generated.
 * Skips if another title generation is already in progress.
 */
export async function generateTitleBatch(
  limit: number = 20,
  force: boolean = false
): Promise<{ generated: number; total: number }> {
  if (titleGenerationRunning) return { generated: 0, total: 0 };
  titleGenerationRunning = true;
  try {
    return await _generateTitleBatchInner(limit, force);
  } finally {
    titleGenerationRunning = false;
  }
}

async function _generateTitleBatchInner(
  limit: number,
  force: boolean
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

  const sessionsText = sessions
    .map((s, i) => {
      const project = pathTail(s.project_path) || "unknown";
      const last = stripContextPreamble((s.last_message || "")).slice(0, 300).replace(/\n/g, " ").replace(/"/g, "'");
      const first = stripContextPreamble((s.first_prompt || "")).slice(0, 120).replace(/\n/g, " ").replace(/"/g, "'");
      return `[${i}] project=${project} | recent: ${last} | started_with: ${first}`;
    })
    .join("\n");

  const prompt = `Generate a short descriptive title (5-10 words, no quotes) for each Claude Code session.
Weight RECENT activity most heavily — the title should reflect what was accomplished at the END of the session, not just how it started. Only fall back to "started_with" if "recent" is ambiguous.
Reply with ONLY numbered lines like:
[0] Title here
[1] Another title

${sessionsText}`;

  const stdout = await runClaudeOneShot({
    prompt,
    args: ["-p", "--model", "haiku", "--output-format", "text"],
    timeoutMs: 90_000,
  });

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

    if (idx >= 0 && idx < sessions.length && title.length > 2 && !EXAMPLE_TITLES.has(title.toLowerCase())) {
      updateStmt.run(title, sessions[idx].message_count, sessions[idx].session_id);
      generated++;
    }
  }

  return { generated, total: sessions.length };
}

/**
 * Generate all missing titles in batches. Skips if already running (shares guard with generateTitleBatch).
 */
export async function generateAllMissingTitles(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    try {
      const { generated } = await generateTitleBatch(20);
      if (generated === 0) break;
    } catch {
      break;
    }
  }
}
