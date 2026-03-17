import { NextRequest } from "next/server";
import { getWorkerRegistry } from "@/lib/worker-registry";

export const dynamic = "force-dynamic";

/** POST /api/workers/[workerId]/heartbeat — send heartbeat */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const body = await request.json().catch(() => ({}));
  const { pendingTaskIds } = body as { pendingTaskIds?: string[] };

  const registry = getWorkerRegistry();
  const result = registry.heartbeat(workerId, pendingTaskIds);

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 404 });
  }

  return Response.json(result);
}
