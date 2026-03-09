import { NextRequest, NextResponse } from "next/server";
import { getDb, searchSessionContent } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  if (!q || q.trim().length < 2) {
    return NextResponse.json({ session_ids: [] });
  }

  const sessionIds = searchSessionContent(q.trim());

  if (sessionIds.length === 0) {
    return NextResponse.json({ session_ids: [] });
  }

  // Return sessions that exist in our DB and are not archived
  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT session_id FROM sessions WHERE session_id IN (${placeholders}) AND archived = 0`
    )
    .all(...sessionIds) as { session_id: string }[];

  return NextResponse.json({ session_ids: rows.map((r) => r.session_id) });
}
