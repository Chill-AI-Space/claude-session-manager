import { NextRequest } from "next/server";
import fs from "fs";
import { getDb, getSessionAlarm } from "@/lib/db";
import { readSessionMessages, readSessionMessagesPaginated } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";
import { isSessionActive, getSessionVitals } from "@/lib/process-detector";
import { hasResultEvent } from "@/lib/orchestrator";
import { resolveNode, proxyJSON } from "@/lib/remote-compute";

// If JSONL hasn't been touched in this many ms AND process is running,
// still consider inactive (catches zombie processes). 60 min is generous
// enough to cover long idle periods where user is thinking.
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  // Check if this is a remote session
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);

  if (node) {
    try {
      // Forward query params (except node) to remote
      const remoteParams = new URLSearchParams(request.nextUrl.searchParams);
      remoteParams.delete("node");
      const qs = remoteParams.toString();
      const res = await proxyJSON(node, `/api/sessions/${sessionId}${qs ? `?${qs}` : ""}`);
      const data = await res.json();
      // Tag the response so the UI knows it's remote
      if (typeof data === "object" && data !== null) {
        (data as Record<string, unknown>)._remote = true;
        (data as Record<string, unknown>)._nodeId = node.id;
        (data as Record<string, unknown>)._nodeName = node.name;
      }
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote fetch failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
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

  // ── Codex sessions: read from JSONL rollout file ─────────────────────────
  const agentType = (session as SessionRow & { agent_type?: string }).agent_type ?? "claude";
  if (agentType === "codex") {
    const { readCodexMessages } = await import("@/lib/codex-db");
    const codexMessages = readCodexMessages(session.jsonl_path);
    let fileMtime = session.file_mtime;
    try {
      const fs2 = await import("fs");
      fileMtime = fs2.statSync(session.jsonl_path).mtimeMs;
    } catch { /* use cached */ }
    const fileAgeMs = Date.now() - (fileMtime || 0);
    const active = fileAgeMs < 5 * 60 * 1000;
    return Response.json({
      session_id: session.session_id,
      project_path: session.project_path,
      messages: codexMessages,
      messages_start: 0,
      messages_total: codexMessages.length,
      metadata: session,
      is_active: active,
      has_result: codexMessages.some(m => m.type === "assistant"),
      file_age_ms: Math.round(fileAgeMs),
      process_vitals: getSessionVitals(sessionId),
    });
  }

  // ── Forge sessions: read from ~/forge/.forge.db ──────────────────────────
  if (agentType === "forge") {
    const { readForgeMessages, getForgeConversation } = await import("@/lib/forge-db");
    const forgeMessages = readForgeMessages(sessionId);
    // Use updated_at directly from Forge's DB for accurate is_active (avoids stale cached file_mtime)
    const forgeRow = getForgeConversation(sessionId);
    const forgeUpdatedAt = forgeRow?.updated_at
      ? new Date(forgeRow.updated_at.replace(" ", "T") + "Z").getTime()
      : session.file_mtime;
    const fileAgeMs = Date.now() - (forgeUpdatedAt || session.file_mtime);
    const active = fileAgeMs < 5 * 60 * 1000;
    return Response.json({
      session_id: session.session_id,
      project_path: session.project_path,
      messages: forgeMessages,
      messages_start: 0,
      messages_total: forgeMessages.length,
      metadata: session,
      is_active: active,
      has_result: forgeMessages.some(m => m.type === "assistant"),
      file_age_ms: Math.round(fileAgeMs),
    });
  }

  // Paginated read — only parses the window we need for large sessions
  const beforeParam = searchParams.has("before")
    ? parseInt(searchParams.get("before")!)
    : undefined;
  const { messages, total, start } = readSessionMessagesPaginated(
    session.jsonl_path,
    { pageSize: PAGE_SIZE, before: beforeParam }
  );

  // Compute last_message_role live from the last message in the result
  // For accuracy, look at the actual last page (when viewing the end of conversation)
  let liveLastMessageRole: string | null = session.last_message_role ?? null;
  if (!beforeParam || beforeParam >= total) {
    // Viewing the tail — last message in our page is the actual last message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
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
  }

  let active = false;
  let fileAgeMs = Infinity;
  const vitals = getSessionVitals(sessionId);
  try {
    active = isSessionActive(sessionId);
    const mtime = fs.statSync(session.jsonl_path).mtimeMs;
    fileAgeMs = Date.now() - mtime;
    // Guard against stale processes: if JSONL hasn't been written to recently,
    // the process is done regardless of what ps reports.
    if (active && fileAgeMs > STALE_THRESHOLD_MS) {
      active = false;
    }
  } catch {
    // ignore
  }

  // Check for result event — if absent and last message is assistant, session exited incomplete
  let sessionHasResult = !!((session as unknown) as Record<string, unknown>).has_result;
  if (!sessionHasResult && liveLastMessageRole === "assistant") {
    // Double-check JSONL (DB might not be updated yet)
    try {
      sessionHasResult = hasResultEvent(session.jsonl_path);
    } catch { /* ignore */ }
  }

  return Response.json({
    session_id: session.session_id,
    project_path: session.project_path,
    messages,
    messages_start: start,
    messages_total: total,
    metadata: { ...session, last_message_role: liveLastMessageRole },
    is_active: active,
    has_result: sessionHasResult,
    file_age_ms: fileAgeMs === Infinity ? null : Math.round(fileAgeMs),
    process_vitals: vitals,
    alarm: getSessionAlarm(sessionId),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();

  // Check if this is a remote session
  const nodeId = request.nextUrl.searchParams.get("node");
  const node = resolveNode(nodeId);

  if (node) {
    try {
      const res = await proxyJSON(node, `/api/sessions/${sessionId}`, "PATCH", body);
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Remote patch failed: ${msg}` }, { status: 502 });
    }
  }

  // Local execution
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

  if (body.model !== undefined) {
    updates.push("model = @model");
    values.model = body.model;
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
