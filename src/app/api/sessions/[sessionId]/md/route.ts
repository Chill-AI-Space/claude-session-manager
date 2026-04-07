import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { sessionToMarkdownPaginated } from "@/lib/jsonl-to-md";
import { resolveNode, proxyJSON } from "@/lib/remote-compute";

export const dynamic = "force-dynamic";

/** Default: render last 30 messages. Use ?limit=0 for all, ?offset=X&limit=Y for explicit range. */
const DEFAULT_MESSAGE_LIMIT = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Check if this is a remote session
  const nodeId = req.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);

  if (node) {
    try {
      const remoteParams = new URLSearchParams(req.nextUrl.searchParams);
      remoteParams.delete("node");
      const qs = remoteParams.toString();
      const res = await proxyJSON(node, `/api/sessions/${sessionId}/md${qs ? `?${qs}` : ""}`);
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote MD fetch failed: ${msg}` }, { status: 502 });
    }
  }

  const db = getDb();
  const session = db
    .prepare("SELECT jsonl_path, project_path, previous_session_id, agent_type FROM sessions WHERE session_id = ?")
    .get(sessionId) as (Pick<SessionRow, "jsonl_path" | "project_path" | "previous_session_id"> & { agent_type?: string }) | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // ── Codex sessions: render from rollout JSONL ────────────────────────────
  if (session.agent_type === "codex") {
    const { readCodexMessages } = await import("@/lib/codex-db");
    const messages = readCodexMessages(session.jsonl_path);
    const parts: string[] = [];
    for (const m of messages) {
      if (m.type === "user") {
        parts.push(`**You**\n\n${m.content as string}\n`);
      } else if (m.type === "assistant") {
        const blocks = Array.isArray(m.content) ? m.content : [];
        const textParts: string[] = [];
        const toolParts: string[] = [];
        for (const b of blocks) {
          if (b.type === "text" && b.text?.trim()) {
            textParts.push(b.text);
          } else if (b.type === "tool_use") {
            const input = b.input as Record<string, unknown>;
            const cmd = input.command ?? input.file_path ?? input.query ?? input.url ?? Object.values(input)[0];
            const detail = cmd ? `: \`${String(cmd).slice(0, 120)}\`` : "";
            toolParts.push(`🔧 **${b.name}**${detail}`);
          }
        }
        const text = [...textParts, ...toolParts].join("\n\n");
        if (text) parts.push(`${text}\n`);
      }
    }
    const markdown = parts.length > 0 ? parts.join("\n---\n\n") : "*(No messages yet)*\n";
    return Response.json({
      markdown,
      session_id: sessionId,
      total_messages: messages.length,
      render_start: 0,
      render_end: messages.length,
      has_earlier: false,
    });
  }

  // ── Forge sessions: render from Forge SQLite ─────────────────────────────
  if (session.jsonl_path?.startsWith("forge://")) {
    const { readForgeMessages } = await import("@/lib/forge-db");
    const messages = readForgeMessages(sessionId);
    const parts: string[] = [];
    for (const m of messages) {
      if (m.type === "user") {
        parts.push(`**You**\n\n${m.content as string}\n`);
      } else if (m.type === "assistant") {
        const text = Array.isArray(m.content)
          ? m.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("\n\n")
          : String(m.content ?? "");
        if (text) parts.push(`${text}\n`);
      }
    }
    const markdown = parts.length > 0 ? parts.join("\n---\n\n") : "*(No messages yet)*\n";
    return Response.json({
      markdown,
      session_id: sessionId,
      total_messages: messages.length,
      render_start: 0,
      render_end: messages.length,
      has_earlier: false,
    });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const offsetParam = req.nextUrl.searchParams.get("offset");

  // limit=0 means "all messages" (no pagination)
  const messageLimit = limitParam != null
    ? (parseInt(limitParam) || undefined)
    : DEFAULT_MESSAGE_LIMIT;
  const messageOffset = offsetParam != null ? parseInt(offsetParam) : undefined;

  try {
    const result = sessionToMarkdownPaginated(session.jsonl_path, {
      sessionId,
      projectPath: session.project_path,
      previousSessionId: session.previous_session_id ?? undefined,
      messageLimit: messageLimit === 0 ? undefined : messageLimit,
      messageOffset,
    });
    return Response.json({
      markdown: result.markdown,
      session_id: sessionId,
      total_messages: result.totalMessages,
      render_start: result.renderStart,
      render_end: result.renderEnd,
      has_earlier: result.renderStart > 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
