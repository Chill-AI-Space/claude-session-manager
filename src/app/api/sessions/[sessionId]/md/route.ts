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
    .prepare("SELECT jsonl_path, project_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as Pick<SessionRow, "jsonl_path" | "project_path"> | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
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
