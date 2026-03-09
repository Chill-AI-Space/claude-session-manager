import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { setSetting, getAllSettings } from "@/lib/db";
import { GDriveAccount } from "@/lib/gdrive";

export const dynamic = "force-dynamic";

const REDIRECT_URI = "http://localhost:3000/api/gdrive/oauth-callback";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`http://localhost:3000/claude-sessions/settings?gdrive_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return NextResponse.redirect("http://localhost:3000/claude-sessions/settings?gdrive_error=missing_code");
  }

  const settings = getAllSettings();
  const pending = JSON.parse(settings.gdrive_oauth_pending ?? "{}");
  const pendingEntry = pending[state];

  if (!pendingEntry) {
    return NextResponse.redirect("http://localhost:3000/claude-sessions/settings?gdrive_error=invalid_state");
  }

  try {
    const oauth2 = new google.auth.OAuth2(pendingEntry.client_id, pendingEntry.client_secret, REDIRECT_URI);
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      return NextResponse.redirect("http://localhost:3000/claude-sessions/settings?gdrive_error=no_refresh_token");
    }

    // Save the account
    const accounts: GDriveAccount[] = JSON.parse(settings.gdrive_accounts ?? "[]");
    const newAccount: GDriveAccount = {
      id: crypto.randomUUID(),
      name: pendingEntry.name,
      type: "oauth",
      client_id: pendingEntry.client_id,
      client_secret: pendingEntry.client_secret,
      refresh_token: tokens.refresh_token,
    };
    accounts.push(newAccount);
    setSetting("gdrive_accounts", JSON.stringify(accounts));

    // Mark state as completed
    const completed = JSON.parse(settings.gdrive_oauth_completed ?? "{}");
    completed[state] = { accountId: newAccount.id, name: newAccount.name };
    setSetting("gdrive_oauth_completed", JSON.stringify(completed));

    // Clean up pending
    delete pending[state];
    setSetting("gdrive_oauth_pending", JSON.stringify(pending));

    return NextResponse.redirect("http://localhost:3000/claude-sessions/settings?gdrive_success=1");
  } catch (err) {
    return NextResponse.redirect(`http://localhost:3000/claude-sessions/settings?gdrive_error=${encodeURIComponent(String(err))}`);
  }
}
