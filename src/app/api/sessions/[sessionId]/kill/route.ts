import { NextRequest } from "next/server";
import { killSessionProcesses } from "@/lib/process-detector";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const killed = killSessionProcesses(sessionId);

  return Response.json({
    killed: killed.length,
    pids: killed,
  });
}
