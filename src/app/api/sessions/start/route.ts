import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";
import { sseResponse } from "@/lib/claude-runner";
import { logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { path: projectPath, message, correlationId } = body as {
    path: string;
    message: string;
    correlationId?: string;
  };

  if (!projectPath || !message?.trim()) {
    return Response.json({ error: "path and message required" }, { status: 400 });
  }

  if (correlationId) {
    logAction("service", "session_start_api_received", JSON.stringify({ correlationId, path: projectPath }));
  }

  const stream = getOrchestrator().start(projectPath, message.trim());
  return sseResponse(stream);
}
