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
  let body: { message?: string; check_after_ms?: number; mode?: string; snooze_ms?: number } = {};
  try {
    body = await request.json();
  } catch { /* empty body is fine */ }

  // Snooze: push the next wake to now + snooze_ms, keeping message/mode as-is.
  // The intended caller is the woken session itself ("give me more time"),
  // which shouldn't have to echo its whole alarm message back.
  if (body.snooze_ms !== undefined) {
    if (typeof body.snooze_ms !== "number" || body.snooze_ms < 1000) {
      return Response.json({ error: "snooze_ms must be a number >= 1000" }, { status: 400 });
    }
    const existing = getSessionAlarm(sessionId);
    if (!existing) {
      return Response.json({ error: "no active alarm to snooze" }, { status: 404 });
    }
    setSessionAlarm(sessionId, existing.message, body.snooze_ms, existing.mode);
    return Response.json({ ok: true, alarm: getSessionAlarm(sessionId) });
  }

  const message = body.message || DEFAULT_MESSAGE;
  const checkAfterMs = body.check_after_ms ?? DEFAULT_CHECK_AFTER_MS;
  const mode = body.mode === "once" ? "once" : "persistent";

  if (typeof checkAfterMs !== "number" || checkAfterMs < 1000) {
    return Response.json({ error: "check_after_ms must be a number >= 1000" }, { status: 400 });
  }

  // Jitter the fire time (3-30s, scaled to ~15% of the delay). Many sessions
  // independently request round-number delays ("5 minutes") from similar
  // starting moments, so without this their alarms cluster and all resume
  // at once — a thundering herd that overloads the orchestrator.
  const jitterMs = Math.floor(Math.random() * Math.min(30_000, Math.max(3_000, checkAfterMs * 0.15)));
  setSessionAlarm(sessionId, message, checkAfterMs + jitterMs, mode);
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
