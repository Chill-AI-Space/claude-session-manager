import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { setSetting, getAllSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

const REDIRECT_URI = "http://localhost:3000/api/gdrive/oauth-callback";
const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

export async function POST(request: NextRequest) {
  const { name, client_id, client_secret } = await request.json() as {
    name: string;
    client_id: string;
    client_secret: string;
  };

  if (!client_id?.trim() || !client_secret?.trim() || !name?.trim()) {
    return NextResponse.json({ error: "name, client_id and client_secret are required" }, { status: 400 });
  }

  const oauth2 = new google.auth.OAuth2(client_id.trim(), client_secret.trim(), REDIRECT_URI);
  const state = crypto.randomUUID();

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent", // always show consent to get refresh_token
  });

  // Store pending OAuth request in settings (keyed by state)
  const settings = getAllSettings();
  const pending = JSON.parse(settings.gdrive_oauth_pending ?? "{}");
  pending[state] = { name: name.trim(), client_id: client_id.trim(), client_secret: client_secret.trim(), created: Date.now() };
  setSetting("gdrive_oauth_pending", JSON.stringify(pending));

  return NextResponse.json({ authUrl, state });
}
