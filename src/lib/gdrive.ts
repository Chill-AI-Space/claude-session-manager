import { google, drive_v3 } from "googleapis";
import { getAllSettings } from "@/lib/db";

export interface GDriveAccount {
  id: string;
  name: string;
  type: "service_account" | "oauth";
  // service_account
  key_path?: string;
  // oauth
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

export function getGDriveAccounts(): GDriveAccount[] {
  const settings = getAllSettings();
  const raw = settings.gdrive_accounts;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function getGDriveClient(accountId: string): Promise<drive_v3.Drive> {
  const accounts = getGDriveAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`GDrive account not found: ${accountId}`);

  if (account.type === "service_account") {
    if (!account.key_path) throw new Error("service_account requires key_path");
    const auth = new google.auth.GoogleAuth({
      keyFile: account.key_path,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    return google.drive({ version: "v3", auth: await auth.getClient() as Parameters<typeof google.drive>[0]["auth"] });
  }

  if (account.type === "oauth") {
    if (!account.client_id || !account.client_secret || !account.refresh_token) {
      throw new Error("oauth account requires client_id, client_secret, refresh_token");
    }
    const oauth2 = new google.auth.OAuth2(account.client_id, account.client_secret);
    oauth2.setCredentials({ refresh_token: account.refresh_token });
    return google.drive({ version: "v3", auth: oauth2 });
  }

  throw new Error(`Unknown account type: ${(account as GDriveAccount).type}`);
}
