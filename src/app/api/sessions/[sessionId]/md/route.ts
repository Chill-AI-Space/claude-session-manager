import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow, ContentBlock } from "@/lib/types";
import { readSessionMessages } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const db = getDb();
  const session = db
    .prepare("SELECT jsonl_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "jsonl_path"> | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const messages = readSessionMessages(session.jsonl_path);
    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.type === "compact_boundary") continue;

      const role = msg.type === "user" ? "**You**" : "**Claude**";
      let text = "";

      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlocks = (msg.content as ContentBlock[])
          .filter((b): b is ContentBlock & { type: "text" } => b.type === "text" && !!(b as { text?: string }).text)
          .map((b) => (b as { text: string }).text)
          .join("\n\n");
        const toolBlocks = (msg.content as ContentBlock[])
          .filter((b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use")
          .map((b) => {
            const tu = b as { name: string; input?: Record<string, unknown> };
            const inputStr = tu.input ? JSON.stringify(tu.input, null, 2) : "";
            return `\`\`\`\n[Tool: ${tu.name}]\n${inputStr}\n\`\`\``;
          })
          .join("\n\n");
        const resultBlocks = (msg.content as ContentBlock[])
          .filter((b): b is ContentBlock & { type: "tool_result" } => b.type === "tool_result")
          .map((b) => {
            const tr = b as { content?: string | Array<{ type: string; text?: string }> };
            const rc = typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.filter((x) => x.type === "text").map((x) => x.text).join("")
                : "";
            return rc ? `<details><summary>Tool result</summary>\n\n\`\`\`\n${rc.slice(0, 2000)}\n\`\`\`\n</details>` : "";
          })
          .filter(Boolean)
          .join("\n\n");
        text = [textBlocks, toolBlocks, resultBlocks].filter(Boolean).join("\n\n");
      }

      if (!text.trim()) continue;
      parts.push(`### ${role}\n\n${text.trim()}`);
    }

    const markdown = parts.join("\n\n---\n\n");
    return Response.json({ markdown });
  } catch {
    return Response.json({ error: "Could not read session file" }, { status: 500 });
  }
}
