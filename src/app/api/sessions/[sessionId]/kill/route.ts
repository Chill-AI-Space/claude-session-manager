import { NextRequest } from "next/server";
import { getOrchestrator } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const result = getOrchestrator().stop(sessionId);
  return Response.json(result);
}
