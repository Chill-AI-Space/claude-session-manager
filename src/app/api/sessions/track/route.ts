import { NextRequest } from "next/server";
import { logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Lightweight client-side event tracker.
 * Used to trace session creation lifecycle end-to-end.
 *
 * POST /api/sessions/track
 * Body: { event: string, correlationId: string, sessionId?: string, meta?: Record<string, unknown> }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { event, correlationId, sessionId, meta } = body as {
      event: string;
      correlationId: string;
      sessionId?: string;
      meta?: Record<string, unknown>;
    };

    if (!event || !correlationId) {
      return Response.json({ error: "event and correlationId required" }, { status: 400 });
    }

    const payload = JSON.stringify({ correlationId, ...meta });
    logAction("service", event, payload, sessionId ?? undefined);

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
}
