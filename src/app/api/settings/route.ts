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

const SENSITIVE_KEYS = new Set([
  "openai_api_key", "anthropic_api_key", "google_ai_api_key",
  "worker_notify_smtp_pass", "relay_node_id",
]);

function maskValue(key: string, value: string): string {
  if (SENSITIVE_KEYS.has(key)) {
    return value ? `***${value.slice(-4)}` : "(cleared)";
  }
  return value;
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      setSetting(key, value);
      logAction("settings", `set_${key}`, maskValue(key, value));
    }
  }
  return Response.json(getAllSettings());
}
