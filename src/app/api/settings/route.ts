import { NextRequest } from "next/server";
import { getAllSettings, setSetting, logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getAllSettings();
  return Response.json({
    ...settings,
    gemini_configured: (process.env.GEMINI_API_KEY || settings.gemini_api_key) ? "true" : "false",
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      setSetting(key, value);
      logAction("settings", `set_${key}`, value);
    }
  }
  return Response.json(getAllSettings());
}
