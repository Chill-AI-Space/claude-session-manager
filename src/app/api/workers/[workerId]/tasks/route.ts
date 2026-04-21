import { NextRequest } from "next/server";
import { getWorkerRegistry } from "@/lib/worker-registry";

export const dynamic = "force-dynamic";

/** GET /api/workers/[workerId]/tasks — list tasks for a worker */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const registry = getWorkerRegistry();
  const tasks = registry.getAllTasks({ workerId });
  return Response.json({ tasks });
}

/** POST /api/workers/[workerId]/tasks — register an in-flight task with full context */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const body = await request.json();
  const { taskId, taskPrompt, contactEmail } = body;

  if (!taskId || !taskPrompt) {
    return Response.json({ error: "taskId and taskPrompt are required" }, { status: 400 });
  }

  const registry = getWorkerRegistry();
  const ok = registry.registerTask({ workerId, taskId, taskPrompt, contactEmail });

  if (!ok) {
    return Response.json({ error: `Worker ${workerId} not registered` }, { status: 404 });
  }

  return Response.json({ ok: true });
}
