import { NextRequest } from "next/server";
import { getDb, getSetting } from "@/lib/db";
import { readSessionMessages, messagesToText } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";
import { summarizeWithMapReduce } from "@/lib/ai-client";

export const dynamic = "force-dynamic";

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

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // Skip meta-analysis sessions (sessions that themselves analyze learnings/summaries)
  const fp = (session.first_prompt || "").toLowerCase();
  if (
    fp.includes("analyzing a claude code session transcript") ||
    fp.includes("extract structured learnings from this session") ||
    fp.includes("generate a short descriptive title")
  ) {
    return Response.json({ error: "Skipped: meta-analysis session" }, { status: 400 });
  }

  // Return cached summary if message count hasn't changed
  const forceRefresh = _request.nextUrl.searchParams.get("refresh") === "1";
  if (!forceRefresh && session.summary) {
    return Response.json({
      summary: session.summary,
      session_id: sessionId,
      cached: true,
    });
  }

  try {
    const model = getSetting("summary_model") || "gemini-2.5-flash";
    const messages = readSessionMessages(session.jsonl_path);
    const sessionText = messagesToText(messages, { maxMessageLen: 2000 });

    if (!sessionText || sessionText.length < 100) {
      return Response.json({ error: "Session too short to summarize" }, { status: 400 });
    }

    const result = await summarizeWithMapReduce({
      model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      text: sessionText,
    });

    // Persist summary to DB for title generation and caching
    db.prepare("UPDATE sessions SET summary = ? WHERE session_id = ?")
      .run(result.text, sessionId);

    return Response.json({
      summary: result.text,
      session_id: sessionId,
      model: result.model,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
