import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

/** GET /api/orchestrator — return queue status + session states */
export async function GET() {
  const orch = getOrchestrator();
  return Response.json({
    queue: orch.getQueueStatus(),
    sessions: orch.getAllStates(),
  });
}

/** POST /api/orchestrator — enqueue a task directly */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { type, sessionId, message, priority, delayMs } = body;

  if (!type || !sessionId) {
    return Response.json({ error: "type and sessionId are required" }, { status: 400 });
  }

  try {
    const taskId = getOrchestrator().enqueue({
      sessionId,
      type,
      message,
      priority,
      delayMs,
    });
    return Response.json({ taskId, ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
