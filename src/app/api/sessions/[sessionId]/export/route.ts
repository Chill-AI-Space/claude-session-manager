import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { readFileSync } from "fs";

export const dynamic = "force-dynamic";

function toReadableText(sessionId: string, jsonlContent: string): string {
  const lines = jsonlContent.split("\n").filter((l) => l.trim());
  const parts: string[] = [`Session: ${sessionId}`, "=".repeat(60), ""];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "user" && obj.type !== "assistant") continue;

      const ts = obj.timestamp ? new Date(obj.timestamp).toLocaleString() : "";
      const role = obj.type === "user" ? "YOU" : "CLAUDE";
      const msg = obj.message;
      if (!msg) continue;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content
          .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
          .map((b: { text: string }) => b.text)
          .join("\n");
        const toolBlocks = msg.content
          .filter((b: { type: string; name?: string }) => b.type === "tool_use" && b.name)
          .map((b: { name: string; input?: Record<string, unknown> }) => {
            const inputStr = b.input ? JSON.stringify(b.input, null, 2) : "";
            return `[TOOL: ${b.name}]\n${inputStr}`;
          })
          .join("\n");
        const resultBlocks = msg.content
          .filter((b: { type: string }) => b.type === "tool_result")
          .map((b: { content?: string | Array<{ type: string; text?: string }> }) => {
            const rc = typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.filter((x) => x.type === "text").map((x) => x.text).join("")
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
    } catch {
      // skip malformed lines
    }
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
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const content = readFileSync(session.jsonl_path, "utf-8");

    if (format === "text") {
      const text = toReadableText(sessionId, content);
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${sessionId.slice(0, 8)}-messages.txt"`,
        },
      });
    }

    return new Response(content, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${sessionId.slice(0, 8)}.jsonl"`,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Could not read session file" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
