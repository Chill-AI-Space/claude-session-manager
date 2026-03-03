import { NextRequest, NextResponse } from "next/server";
import { scanSessions } from "@/lib/scanner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "full" ? "full" : "incremental";

  const result = await scanSessions(mode);

  return NextResponse.json(result);
}
