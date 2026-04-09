import { NextRequest } from "next/server";
import { getSessionAlarm, setSessionAlarm, disableSessionAlarm, isBabysitterDisabled } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULT_CHECK_AFTER_MS = 3 * 60 * 1000; // 3 minutes
const DEFAULT_MESSAGE =
  "Your session was interrupted. Please review your last task and continue from where you left off.";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const alarm = getSessionAlarm(sessionId);
  const disabled = !alarm && isBabysitterDisabled(sessionId);
  return Response.json(alarm ?? { alarm: null, babysitter_disabled: disabled });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  let body: { message?: string; check_after_ms?: number } = {};
  try {
    body = await request.json();
  } catch { /* empty body is fine */ }

  const message = body.message || DEFAULT_MESSAGE;
  const checkAfterMs = body.check_after_ms ?? DEFAULT_CHECK_AFTER_MS;

  if (typeof checkAfterMs !== "number" || checkAfterMs < 1000) {
    return Response.json({ error: "check_after_ms must be a number >= 1000" }, { status: 400 });
  }

  setSessionAlarm(sessionId, message, checkAfterMs);
  const alarm = getSessionAlarm(sessionId);
  return Response.json({ ok: true, alarm });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  // ?clear=true — fully removes the record (re-enables babysitter)
  const fullyRemove = request.nextUrl.searchParams.get("clear") === "true";
  if (fullyRemove) {
    const { clearSessionAlarm } = await import("@/lib/db");
    clearSessionAlarm(sessionId);
    return Response.json({ ok: true, babysitter_disabled: false });
  }
  // Default: set disabled=1 — tells babysitter to leave this session alone
  disableSessionAlarm(sessionId);
  return Response.json({ ok: true, babysitter_disabled: true });
}
