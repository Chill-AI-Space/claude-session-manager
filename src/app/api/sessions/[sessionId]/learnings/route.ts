import { NextRequest } from "next/server";
import { getDb, getSetting } from "@/lib/db";
import { readSessionMessages, messagesToText } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";
import { summarizeWithMapReduce } from "@/lib/ai-client";

export const dynamic = "force-dynamic";

const EXTRACTION_PROMPT = `You are analyzing a Claude Code session transcript. Extract structured learnings from this session.

Return a JSON object with these categories (use empty arrays if nothing fits):

{
  "summary": "1-2 sentence summary of what was accomplished in this session",
  "discoveries": ["Things that turned out to work better than the old approach — 'we used to do X, discovered Y works better because Z'"],
  "friction_loops": ["Moments where the conversation went in circles, there was misunderstanding, or things were redone multiple times — what was the root cause and how it was resolved"],
  "claude_md_rules": ["Rules/conventions that should be saved in CLAUDE.md for this project — things Claude should always remember"],
  "patterns": ["Coding patterns, architectural decisions, or conventions established"],
  "bugs_fixed": ["Bugs discovered and how they were fixed — include root cause"],
  "tools_learned": ["New tools, commands, APIs, or techniques discovered"],
  "preferences": ["User preferences for workflow, communication, or code style"],
  "gotchas": ["Pitfalls, edge cases, or 'things that don't work as expected'"],
  "prompt_coaching": ["Analysis of user prompts — what was suboptimal and how to prompt better. Format each item as: '❌ What user did → ✅ Better approach'. Focus on: vague instructions that caused confusion, missing context that led to wrong assumptions, overly long prompts that could be shorter, cases where user could have given an example or constraint upfront, unnecessary back-and-forth that a better initial prompt would have avoided"]
}

Rules:
- Be specific and actionable — each item should be useful as a future reference
- For discoveries: focus on paradigm shifts — what changed and why the new way is better
- For friction_loops: detecting miscommunication patterns is the value — what caused the loop and what finally resolved it
- For claude_md_rules, write them as direct instructions (e.g. "Always use X when doing Y")
- For prompt_coaching: be constructive, not critical. Show the concrete prompt that would have worked better. Only flag patterns that genuinely wasted time or caused misunderstanding — skip nitpicks
- Skip trivial items — only include things worth remembering
- Keep each item to 1-2 sentences max
- Write in the same language the user used in the session
- Return ONLY the JSON object, no markdown fences, no explanation`;

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

  // Return cached learnings if available
  const forceRefresh = _request.nextUrl.searchParams.get("refresh") === "1";
  const cachedLearnings = (session as unknown as Record<string, unknown>).learnings as string | null;
  if (!forceRefresh && cachedLearnings) {
    try {
      return Response.json({
        learnings: JSON.parse(cachedLearnings),
        session_id: sessionId,
        cached: true,
      });
    } catch { /* invalid JSON, regenerate */ }
  }

  try {
    const model = getSetting("learnings_model") || "gemini-2.5-flash";
    const messages = readSessionMessages(session.jsonl_path);
    const sessionText = messagesToText(messages, { maxMessageLen: 2000 });

    if (!sessionText || sessionText.length < 100) {
      return Response.json({ error: "Session too short to extract learnings" }, { status: 400 });
    }

    const result = await summarizeWithMapReduce({
      model,
      systemPrompt: EXTRACTION_PROMPT,
      text: sessionText,
    });

    // Parse JSON from response (handle possible markdown fences)
    let cleaned = result.text;
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) cleaned = jsonMatch[1];

    // Try to find JSON object
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      console.error("[learnings] No JSON found in response:", result.text);
      return Response.json({
        error: "Failed to parse learnings — LLM did not return valid JSON",
        raw: result.text.slice(0, 1000), // First 1000 chars for debugging
        model: result.model,
      }, { status: 500 });
    }

    const learnings = JSON.parse(objMatch[0]);

    // Cache learnings in DB
    db.prepare("UPDATE sessions SET learnings = ? WHERE session_id = ?")
      .run(JSON.stringify(learnings), sessionId);

    return Response.json({
      learnings,
      session_id: sessionId,
      model: result.model,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pass through 4xx errors from the AI API (e.g., location not supported, invalid key)
    const clientErr = /(?:error|status)\s+4\d\d/i.test(msg);
    return Response.json({ error: msg }, { status: clientErr ? 400 : 500 });
  }
}
