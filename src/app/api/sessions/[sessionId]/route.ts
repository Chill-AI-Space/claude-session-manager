import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readSessionMessages } from "@/lib/session-reader";
import { SessionRow } from "@/lib/types";
import { isSessionActive } from "@/lib/process-detector";

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
    return NextResponse.json(
      { error: "Session not found" },
      { status: 404 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const limit = searchParams.get("limit")
    ? parseInt(searchParams.get("limit")!)
    : undefined;
  const offset = searchParams.get("offset")
    ? parseInt(searchParams.get("offset")!)
    : undefined;

  const messages = readSessionMessages(session.jsonl_path, {
    limit,
    offset,
  });

  let active = false;
  try {
    active = isSessionActive(sessionId);
  } catch {
    // ignore
  }

  return NextResponse.json({
    session_id: session.session_id,
    project_path: session.project_path,
    messages,
    metadata: session,
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
    return NextResponse.json(
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

  return NextResponse.json(updated);
}
