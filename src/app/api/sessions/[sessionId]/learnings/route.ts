import { NextRequest } from "next/server";
import { getDb, getSetting } from "@/lib/db";
import { readSessionMessages } from "@/lib/session-reader";
import { SessionRow, ContentBlock } from "@/lib/types";
import { runClaudeOneShot } from "@/lib/claude-runner";

export const dynamic = "force-dynamic";

/** Extract plain text from session messages for the prompt */
function extractSessionText(jsonlPath: string, maxChars = 60_000): string {
  const messages = readSessionMessages(jsonlPath);
  const parts: string[] = [];
  let totalLen = 0;

  for (const msg of messages) {
    if (msg.type === "compact_boundary") continue;

    let text = "";
    if (msg.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        text = `[User]: ${content}`;
      } else if (Array.isArray(content)) {
        const textParts = (content as ContentBlock[])
          .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text" && !!b.text)
          .map((b) => b.text);
        if (textParts.length) text = `[User]: ${textParts.join("\n")}`;
      }
    } else if (msg.type === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        text = `[Claude]: ${content}`;
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content as ContentBlock[]) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use" && block.name) {
            textParts.push(`[tool: ${block.name}]`);
          }
        }
        if (textParts.length) text = `[Claude]: ${textParts.join("\n")}`;
      }
    }

    if (!text) continue;

    // Truncate individual messages
    if (text.length > 2000) text = text.slice(0, 2000) + "...";

    if (totalLen + text.length > maxChars) break;
    parts.push(text);
    totalLen += text.length;
  }

  return parts.join("\n\n");
}

const EXTRACTION_PROMPT = `You are analyzing a Claude Code session transcript. Extract structured learnings from this session.

Return a JSON object with these categories (use empty arrays if nothing fits):

{
  "summary": "1-2 sentence summary of what was accomplished in this session",
  "claude_md_rules": ["Rules/conventions that should be saved in CLAUDE.md for this project — things Claude should always remember"],
  "patterns": ["Coding patterns, architectural decisions, or conventions established"],
  "bugs_fixed": ["Bugs discovered and how they were fixed — include root cause"],
  "tools_learned": ["New tools, commands, APIs, or techniques discovered"],
  "preferences": ["User preferences for workflow, communication, or code style"],
  "gotchas": ["Pitfalls, edge cases, or 'things that don't work as expected'"]
}

Rules:
- Be specific and actionable — each item should be useful as a future reference
- For claude_md_rules, write them as direct instructions (e.g. "Always use X when doing Y")
- Skip trivial items — only include things worth remembering
- Keep each item to 1-2 sentences max
- Return ONLY the JSON object, no markdown fences, no explanation

Session transcript:
`;

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

  try {
    const sessionText = extractSessionText(session.jsonl_path);
    if (!sessionText || sessionText.length < 100) {
      return Response.json({ error: "Session too short to extract learnings" }, { status: 400 });
    }

    const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
    const args = ["-p", "--model", "haiku", "--output-format", "text"];
    if (skipPermissions) args.push("--dangerously-skip-permissions");

    const raw = await runClaudeOneShot({
      prompt: EXTRACTION_PROMPT + sessionText,
      args,
      timeoutMs: 120_000,
    });

    // Parse JSON from response (handle possible markdown fences)
    let cleaned = raw;
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) cleaned = jsonMatch[1];

    // Try to find JSON object
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      return Response.json({ error: "Failed to parse learnings", raw }, { status: 500 });
    }

    const learnings = JSON.parse(objMatch[0]);
    return Response.json({ learnings, session_id: sessionId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
