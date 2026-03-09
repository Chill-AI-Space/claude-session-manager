import { NextRequest, NextResponse } from "next/server";
import { getGDriveClient } from "@/lib/gdrive";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { accountId } = await request.json() as { accountId: string };
  if (!accountId) return NextResponse.json({ ok: false, error: "accountId required" }, { status: 400 });

  try {
    const drive = await getGDriveClient(accountId);
    await drive.files.list({ q: "'root' in parents", pageSize: 1, fields: "files(id)" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) });
  }
}
