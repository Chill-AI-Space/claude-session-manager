import { NextResponse } from "next/server";
import { getPendingPermissions, getPendingForSession } from "@/lib/permissions";

// GET: UI polls for pending permission requests
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");

  const pending = sessionId
    ? getPendingForSession(sessionId)
    : getPendingPermissions();

  return NextResponse.json(pending);
}
