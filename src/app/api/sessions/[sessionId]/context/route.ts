import { NextRequest } from "next/server";
import { getDb, getSetting } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { readSessionMessages, messagesToText } from "@/lib/session-reader";
import { resolveNode, proxyJSON } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const nodeId = req.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);
  if (node) {
    try {
      const body = await req.json();
      const res = await proxyJSON(node, `/api/sessions/${sessionId}/context`, "POST", body);
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote context fetch failed: ${msg}` }, { status: 502 });
    }
  }

  const body = await req.json();
  const question = body.question;

  if (!question || typeof question !== "string") {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  const db = getDb();
  const session = db
    .prepare("SELECT session_id, jsonl_path, generated_title, custom_name, agent_type FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "jsonl_path" | "generated_title" | "custom_name"> | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const messages = await readMessagesForContext(sessionId, session as Pick<SessionRow, "jsonl_path" | "agent_type">);
  if (messages.length === 0) {
    return Response.json({ error: "Could not read session file" }, { status: 500 });
  }
  const transcript = messagesToText(messages);

  // If transcript is tiny, just return it as-is — no need for AI
  if (transcript.length < 2000) {
    return Response.json({
      context: transcript,
      method: "full",
      gemini_configured: !!getSetting("google_ai_api_key") || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_AI_API_KEY,
    });
  }

  const apiKey = getSetting("google_ai_api_key") || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    // Fallback: last messages + first message (more relevant than just first 4000 chars)
    const fallback = smartTruncate(transcript, 4000);
    return Response.json({ context: fallback, method: "truncated", gemini_configured: false });
  }

  // Gemini: extract relevant context for the new question
  const title = session.custom_name || session.generated_title || "Untitled";
  const geminiPrompt = `You are a context extractor. A user had a coding session titled "${title}" with an AI assistant. Now they want to start a NEW session with a new question.

Extract ONLY the parts from the previous session that are relevant to their new question. Include:
- Key decisions, architecture choices, file paths mentioned
- Code snippets or patterns that relate to the new question
- Any problems/solutions that provide useful background

Skip:
- Greetings, acknowledgements, unrelated discussion
- Tool calls and their raw output (summarize what was done instead)
- Anything not relevant to the new question

Previous session transcript (may be long):
${transcript.slice(0, 30000)}

New question the user wants to ask:
"${question.slice(0, 500)}"

Return a concise summary (500-2000 chars) of ONLY the relevant context. If nothing is relevant, return "No relevant context from previous session."`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const fallback = smartTruncate(transcript, 4000);
      return Response.json({ context: fallback, method: "truncated", gemini_configured: true });
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

    if (!text || text.length < 10) {
      const fallback = smartTruncate(transcript, 4000);
      return Response.json({ context: fallback, method: "truncated", gemini_configured: true });
    }

    return Response.json({ context: text, method: "gemini", gemini_configured: true });
  } catch {
    const fallback = smartTruncate(transcript, 4000);
    return Response.json({ context: fallback, method: "truncated", gemini_configured: true });
  }
}

async function readMessagesForContext(
  sessionId: string,
  session: Pick<SessionRow, "jsonl_path" | "agent_type">
) {
  const agentType = session.agent_type ?? "claude";
  if (agentType === "codex") {
    const { readCodexMessages } = await import("@/lib/codex-db");
    return readCodexMessages(session.jsonl_path);
  }
  if (agentType === "forge") {
    const { readForgeMessages } = await import("@/lib/forge-db");
    return readForgeMessages(sessionId);
  }
  return readSessionMessages(session.jsonl_path);
}

/** Smart truncation: first message + last messages (more useful than head-only) */
function smartTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const messages = text.split(/\n\n(?=(?:USER|CLAUDE): )/);
  if (messages.length <= 2) return text.slice(0, maxLen);

  const first = messages[0];
  const budget = maxLen - first.length - 100; // 100 for separator
  if (budget <= 0) return text.slice(0, maxLen);

  // Take last messages that fit
  const tail: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (used + messages[i].length > budget) break;
    tail.unshift(messages[i]);
    used += messages[i].length;
  }

  if (tail.length === 0) return text.slice(0, maxLen);

  const skipped = messages.length - 1 - tail.length;
  const separator = skipped > 0 ? `\n\n[... ${skipped} messages skipped ...]\n\n` : "\n\n";
  return first + separator + tail.join("\n\n");
}
