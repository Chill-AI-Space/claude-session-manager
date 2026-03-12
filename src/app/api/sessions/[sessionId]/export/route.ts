import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow, ContentBlock } from "@/lib/types";
import { readFileSync } from "fs";
import { readSessionMessages } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

function toReadableText(sessionId: string, jsonlPath: string): string {
  const messages = readSessionMessages(jsonlPath);
  const parts: string[] = [`Session: ${sessionId}`, "=".repeat(60), ""];

  for (const msg of messages) {
    if (msg.type === "compact_boundary") continue;

    const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : "";
    const role = msg.type === "user" ? "YOU" : "CLAUDE";

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textBlocks = (msg.content as ContentBlock[])
        .filter((b): b is ContentBlock & { type: "text" } => b.type === "text" && !!(b as { text?: string }).text)
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const toolBlocks = (msg.content as ContentBlock[])
        .filter((b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use")
        .map((b) => {
          const tu = b as { name: string; input?: Record<string, unknown> };
          const inputStr = tu.input ? JSON.stringify(tu.input, null, 2) : "";
          return `[TOOL: ${tu.name}]\n${inputStr}`;
        })
        .join("\n");
      const resultBlocks = (msg.content as ContentBlock[])
        .filter((b): b is ContentBlock & { type: "tool_result" } => b.type === "tool_result")
        .map((b) => {
          const tr = b as { content?: string | Array<{ type: string; text?: string }> };
          const rc = typeof tr.content === "string"
            ? tr.content
            : Array.isArray(tr.content)
              ? tr.content.filter((x) => x.type === "text").map((x) => x.text).join("")
              : "";
          return rc ? `[TOOL RESULT]\n${rc.slice(0, 500)}` : "";
        })
        .filter(Boolean)
        .join("\n");
      text = [textBlocks, toolBlocks, resultBlocks].filter(Boolean).join("\n");
    }

    if (!text.trim()) continue;
    parts.push(`[${ts}] ${role}:`);
    parts.push(text.trim());
    parts.push("");
  }

  return parts.join("\n");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const format = req.nextUrl.searchParams.get("format");

  const db = getDb();
  const session = db
    .prepare("SELECT jsonl_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "jsonl_path"> | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    if (format === "text") {
      const text = toReadableText(sessionId, session.jsonl_path);
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${sessionId.slice(0, 8)}-messages.txt"`,
        },
      });
    }

    const content = readFileSync(session.jsonl_path, "utf-8");
    return new Response(content, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${sessionId.slice(0, 8)}.jsonl"`,
      },
    });
  } catch {
    return Response.json({ error: "Could not read session file" }, { status: 500 });
  }
}
