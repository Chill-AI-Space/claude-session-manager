import { NextRequest, NextResponse } from "next/server";
import { getGDriveClient } from "@/lib/gdrive";
import { FileEntry } from "@/app/api/files/route";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  const folderId = request.nextUrl.searchParams.get("folderId") ?? "root";

  if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });

  try {
    const drive = await getGDriveClient(accountId);
    const query = folderId === "roots"
      ? "'me' in owners and 'root' in parents and trashed = false"
      : `'${folderId}' in parents and trashed = false`;

    const res = await drive.files.list({
      q: query,
      fields: "files(id, name, mimeType, size, modifiedTime)",
      pageSize: 200,
      orderBy: "folder,name",
    });

    const files = res.data.files ?? [];
    const entries: (FileEntry & { driveId: string })[] = files.map((f) => {
      const isDir = f.mimeType === "application/vnd.google-apps.folder";
      const name = f.name ?? "untitled";
      const ext = isDir ? "" : (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
      return {
        driveId: f.id ?? "",
        name,
        path: f.id ?? "",  // use fileId as path for gdrive
        type: isDir ? "dir" : "file",
        ext,
        size: parseInt(f.size ?? "0"),
        mtime: f.modifiedTime ?? new Date().toISOString(),
      };
    });

    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
