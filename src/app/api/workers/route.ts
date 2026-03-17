import { NextRequest } from "next/server";
import { getWorkerRegistry } from "@/lib/worker-registry";

export const dynamic = "force-dynamic";

/** GET /api/workers — list all workers with current state */
export async function GET() {
  const registry = getWorkerRegistry();
  return Response.json({
    workers: registry.getAllWorkers(),
  });
}

/** POST /api/workers — register a new worker */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { workerId, projectDomain, heartbeatIntervalMs, meta } = body;

  if (!projectDomain) {
    return Response.json({ error: "projectDomain is required" }, { status: 400 });
  }

  const registry = getWorkerRegistry();
  const state = registry.register({ workerId, projectDomain, heartbeatIntervalMs, meta });

  return Response.json({
    workerId: state.workerId,
    phase: state.phase,
    nextHeartbeatMs: state.heartbeatIntervalMs,
  });
}

/** DELETE /api/workers?workerId=... — unregister a worker */
export async function DELETE(request: NextRequest) {
  const workerId = request.nextUrl.searchParams.get("workerId");
  if (!workerId) {
    return Response.json({ error: "workerId query param required" }, { status: 400 });
  }

  const registry = getWorkerRegistry();
  const removed = registry.unregister(workerId);

  return Response.json({ ok: removed });
}
