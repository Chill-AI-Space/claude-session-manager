import { NextRequest, NextResponse } from "next/server";
import { scanSessions } from "@/lib/scanner";
import { generateAllMissingTitles } from "@/lib/title-generator";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "full" ? "full" : "incremental";

  const result = await scanSessions(mode);

  // Fire-and-forget: generate titles for any new sessions
  if (result.sessionsScanned > 0) {
    generateAllMissingTitles().catch(() => {});
  }

  return NextResponse.json(result);
}
