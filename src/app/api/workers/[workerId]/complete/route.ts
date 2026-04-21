import { NextRequest } from "next/server";
import { getWorkerRegistry } from "@/lib/worker-registry";
import { sendEmail } from "@/lib/worker-fallback";

export const dynamic = "force-dynamic";

/** POST /api/workers/[workerId]/complete — report task completion */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workerId: string }> }
) {
  const { workerId } = await params;
  const body = await request.json();
  const { taskId, summary, contactEmail } = body;

  if (!taskId) {
    return Response.json({ error: "taskId is required" }, { status: 400 });
  }

  const registry = getWorkerRegistry();
  const worker = registry.getWorker(workerId);
  if (!worker) {
    return Response.json({ error: `Worker ${workerId} not registered` }, { status: 404 });
  }

  const ok = registry.completeTask(workerId, taskId, {
    summary: summary || "completed",
    contactEmail,
  });

  if (!ok) {
    return Response.json({ error: "Task completion failed" }, { status: 500 });
  }

  // Send email notification if contact provided
  const emailTo = contactEmail || body.email;
  if (emailTo && summary) {
    await sendEmail({
      to: emailTo,
      subject: `Task completed: ${taskId}`,
      body: summary,
    }).catch(() => {});
  }

  return Response.json({ ok: true });
}
