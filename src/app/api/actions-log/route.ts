import { NextRequest } from "next/server";
import { getActionsLog, getActionStats, logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  if (sp.get("stats") === "1") {
    return Response.json(getActionStats());
  }

  const entries = getActionsLog({
    limit: parseInt(sp.get("limit") ?? "500") || 500,
    action: sp.get("action") ?? undefined,
    sessionId: sp.get("session_id") ?? undefined,
    type: sp.get("type") ?? undefined,
    since: sp.get("since") ?? undefined,
  });
  return Response.json(entries);
}

export async function POST(request: NextRequest) {
  const { type, action, details, session_id } = await request.json();
  if (!type || !action) return Response.json({ error: "type and action required" }, { status: 400 });
  logAction(type, action, details, session_id);
  return Response.json({ ok: true });
}
