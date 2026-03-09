import { NextRequest, NextResponse } from "next/server";
import { getAllSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  if (!state) return NextResponse.json({ done: false });

  const settings = getAllSettings();
  const completed = JSON.parse(settings.gdrive_oauth_completed ?? "{}");

  if (completed[state]) {
    return NextResponse.json({ done: true, ...completed[state] });
  }

  return NextResponse.json({ done: false });
}
