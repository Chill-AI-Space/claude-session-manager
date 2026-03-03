import { NextResponse } from "next/server";
import { detectActiveClaudeSessions } from "@/lib/process-detector";

export const dynamic = "force-dynamic";

export async function GET() {
  const processes = detectActiveClaudeSessions();

  return NextResponse.json({ processes });
}
