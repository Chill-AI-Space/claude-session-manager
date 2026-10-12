import { NextResponse } from "next/server";
import { detectActiveClaudeSessions, getProcessDetectionDiagnostics } from "@/lib/process-detector";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const processes = detectActiveClaudeSessions();

  if (new URL(request.url).searchParams.has("diagnose")) {
    try {
      return NextResponse.json({ processes, diagnostics: getProcessDetectionDiagnostics() });
    } catch (error) {
      return NextResponse.json({ processes, diagnostics: { error: String(error) } });
    }
  }
  return NextResponse.json({ processes });
}
