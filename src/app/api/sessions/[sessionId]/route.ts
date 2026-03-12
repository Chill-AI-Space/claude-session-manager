import { NextRequest } from "next/server";
import fs from "fs";
import { getDb } from "@/lib/db";
import { readSessionMessages } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";
import { isSessionActive } from "@/lib/process-detector";

// If JSONL hasn't been touched in this many ms, session is definitely done
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json(
      { error: "Session not found" },
      { status: 404 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const PAGE_SIZE = 100;

  // Read all messages first to get total count
  const allMessages = readSessionMessages(session.jsonl_path);
  const total = allMessages.length;

  // Default: last PAGE_SIZE messages. "before" param = load messages before index.
  const before = searchParams.has("before")
    ? parseInt(searchParams.get("before")!)
    : total;
  const start = Math.max(0, before - PAGE_SIZE);
  const messages = allMessages.slice(start, before);

  // Compute last_message_role live from JSONL (avoids stale DB value after retries)
  let liveLastMessageRole: string | null = session.last_message_role ?? null;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (msg.type === "compact_boundary") continue;
    if (msg.type === "assistant") {
      liveLastMessageRole = "assistant";
    } else if (msg.type === "user") {
      const content = msg.content;
      const isToolResult =
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b) => (b as { type: string }).type === "tool_result");
      liveLastMessageRole = isToolResult ? "tool_result" : "user";
    }
    break;
  }

  let active = false;
  try {
    active = isSessionActive(sessionId);
    // Guard against stale processes: if JSONL hasn't been written to recently,
    // the process is done regardless of what ps reports.
    if (active) {
      const mtime = fs.statSync(session.jsonl_path).mtimeMs;
      if (Date.now() - mtime > STALE_THRESHOLD_MS) {
        active = false;
      }
    }
  } catch {
    // ignore
  }

  return Response.json({
    session_id: session.session_id,
    project_path: session.project_path,
    messages,
    messages_start: start,
    messages_total: total,
    metadata: { ...session, last_message_role: liveLastMessageRole },
    is_active: active,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json(
      { error: "Session not found" },
      { status: 404 }
    );
  }

  const updates: string[] = [];
  const values: Record<string, string | number> = {
    session_id: sessionId,
  };

  if (body.custom_name !== undefined) {
    updates.push("custom_name = @custom_name");
    values.custom_name = body.custom_name;
  }

  if (body.tags !== undefined) {
    updates.push("tags = @tags");
    values.tags = JSON.stringify(body.tags);
  }

  if (body.pinned !== undefined) {
    updates.push("pinned = @pinned");
    values.pinned = body.pinned ? 1 : 0;
  }

  if (body.archived !== undefined) {
    updates.push("archived = @archived");
    values.archived = body.archived ? 1 : 0;
  }

  if (updates.length > 0) {
    db.prepare(
      `UPDATE sessions SET ${updates.join(", ")} WHERE session_id = @session_id`
    ).run(values);
  }

  const updated = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId);

  return Response.json(updated);
}
