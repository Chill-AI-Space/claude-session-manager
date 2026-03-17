import { getDb, getSetting } from "./db";
import { pathTail } from "./utils";
import { completion, summarizeWithMapReduce } from "./ai-client";
import { readSessionMessages, messagesToText } from "./session-reader";

interface SessionForTitle {
  session_id: string;
  first_prompt: string | null;
  project_path: string;
  message_count: number;
  summary: string | null;
  jsonl_path: string;
}

// Titles from the prompt examples that should never be saved
const EXAMPLE_TITLES = new Set(["title here", "another title"]);

const SUMMARY_SYSTEM_PROMPT = `You are analyzing a Claude Code session transcript. Write a concise summary in Markdown format.

Structure:
## Summary
1-3 sentences: what was the goal and what was accomplished.

## What was done
Bullet list of concrete actions taken (files created, modified, bugs fixed, features added). Be specific — include file names and what changed.

## Key decisions
Bullet list of important decisions made during the session (architecture choices, trade-offs, approaches chosen/rejected).

## Result
1-2 sentences: final state — what works now, what was left unfinished.

Rules:
- Be specific and concise — every bullet should contain a concrete fact
- Use code formatting for file names, function names, commands
- Skip trivial actions (reading files just to understand structure)
- If the session was short or trivial, keep the summary proportionally short
- Write in the same language the user used in the session (if Russian, write in Russian)
- Return ONLY the markdown, no fences around the whole thing`;

// Concurrency guard — only one title generation call at a time
let titleGenerationRunning = false;

/**
 * Generate titles for a batch of sessions. Returns number generated.
 * Uses session summaries as input — generates summaries first if missing.
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

/**
 * Generate summary for a single session and save to DB.
 * Returns the summary text or null if generation failed.
 */
async function generateAndSaveSummary(session: SessionForTitle): Promise<string | null> {
  try {
    // Skip meta-analysis sessions
    const fp = (session.first_prompt || "").toLowerCase();
    if (
      fp.includes("analyzing a claude code session transcript") ||
      fp.includes("extract structured learnings from this session") ||
      fp.includes("generate a short descriptive title")
    ) {
      return null;
    }

    const model = getSetting("summary_model") || "gpt-4o-mini";
    const messages = readSessionMessages(session.jsonl_path);
    const sessionText = messagesToText(messages, { maxMessageLen: 2000 });

    if (!sessionText || sessionText.length < 100) return null;

    const result = await summarizeWithMapReduce({
      model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      text: sessionText,
    });

    // Save to DB
    const db = getDb();
    db.prepare("UPDATE sessions SET summary = ? WHERE session_id = ?")
      .run(result.text, session.session_id);

    return result.text;
  } catch {
    return null;
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
      `SELECT session_id, first_prompt, project_path, message_count, summary, jsonl_path
       FROM sessions ${whereClause}
       ORDER BY modified_at DESC LIMIT ?`
    )
    .all(limit) as SessionForTitle[];

  if (sessions.length === 0) {
    return { generated: 0, total: 0 };
  }

  // Phase 1: Generate summaries for sessions that don't have one
  const needSummary = sessions.filter(s => !s.summary && s.message_count >= 4);
  if (needSummary.length > 0) {
    // Generate summaries sequentially to avoid overloading APIs
    for (const s of needSummary) {
      const summaryText = await generateAndSaveSummary(s);
      if (summaryText) s.summary = summaryText;
    }
  }

  // Phase 2: Generate titles from summaries
  // Split into sessions with summaries (use summary) and without (skip — too short to title well)
  const sessionsWithSummary = sessions.filter(s => s.summary);
  if (sessionsWithSummary.length === 0) {
    return { generated: 0, total: sessions.length };
  }

  const sessionsText = sessionsWithSummary
    .map((s, i) => {
      const project = pathTail(s.project_path) || "unknown";
      // Extract just the ## Summary section (1-3 sentences) — most useful for title
      const summarySection = extractSummarySection(s.summary!);
      return `[${i}] project=${project} | ${summarySection}`;
    })
    .join("\n");

  const titleModel = getSetting("title_model") || "gpt-4o-mini";
  const result = await completion({
    model: titleModel,
    systemPrompt: `You generate short titles for Claude Code sessions. Rules:
- 4-8 words, NO quotes around the title
- Extract the CORE action or problem — not a sentence, a label
- Strip filler: never start with "Goal:", "Session:", "Task:", "Цель:", "Работа над"
- Good: "Chunk loading fix in Next.js", "Dark mode toggle implementation", "Миграция БД на PostgreSQL"
- Bad: "The goal was to fix chunk loading errors", "Session about implementing dark mode"
- Write in the same language as the summary
- Reply with ONLY numbered lines like:
[0] Title here
[1] Another title`,
    userPrompt: sessionsText,
  });

  const updateStmt = db.prepare(
    "UPDATE sessions SET generated_title = ?, titled_at_count = ? WHERE session_id = ?"
  );

  let generated = 0;
  const lines = result.text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (!match) continue;

    const idx = parseInt(match[1]);
    const title = match[2].trim().replace(/^["']|["']$/g, "");

    if (idx >= 0 && idx < sessionsWithSummary.length && title.length > 2 && !EXAMPLE_TITLES.has(title.toLowerCase())) {
      updateStmt.run(title, sessionsWithSummary[idx].message_count, sessionsWithSummary[idx].session_id);
      generated++;
    }
  }

  return { generated, total: sessions.length };
}

/**
 * Extract the "## Summary" section from a full summary markdown.
 * Falls back to the first 200 chars if no section found.
 */
function extractSummarySection(summary: string): string {
  // Try to find ## Summary section
  const match = summary.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$|$)/i);
  if (match) {
    return match[1].trim().slice(0, 300);
  }
  // Fallback: first 300 chars
  return summary.slice(0, 300).replace(/\n/g, " ");
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
