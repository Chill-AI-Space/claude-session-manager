import { NextRequest, NextResponse } from "next/server";
import { getGDriveClient } from "@/lib/gdrive";

export const dynamic = "force-dynamic";

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/html", "text/css", "text/javascript",
  "application/json", "application/xml", "text/xml", "text/markdown",
  "text/csv", "application/javascript", "application/typescript",
]);

const GOOGLE_DOCS_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");
  const fileId = request.nextUrl.searchParams.get("fileId");

  if (!accountId || !fileId) {
    return NextResponse.json({ error: "accountId and fileId required" }, { status: 400 });
  }

  try {
    const drive = await getGDriveClient(accountId);

    // Get file metadata
    const meta = await drive.files.get({ fileId, fields: "id,name,mimeType,size" });
    const mimeType = meta.data.mimeType ?? "";
    const name = meta.data.name ?? fileId;
    const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

    // Google Docs — export as text
    if (GOOGLE_DOCS_MIME[mimeType]) {
      const exported = await drive.files.export(
        { fileId, mimeType: GOOGLE_DOCS_MIME[mimeType] },
        { responseType: "text" }
      );
      return NextResponse.json({ type: "text", content: exported.data as string, ext, name });
    }

    // PDF
    if (mimeType === "application/pdf") {
      return NextResponse.json({ type: "pdf", name, ext: "pdf" });
    }

    // Images
    const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
    if (imageTypes.has(mimeType)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (drive.files.get as any)({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      const buffer = Buffer.from(res.data as ArrayBuffer);
      return new NextResponse(buffer, {
        headers: { "Content-Type": mimeType, "Cache-Control": "private, max-age=300" },
      });
    }

    // Text files
    if (TEXT_MIME_TYPES.has(mimeType) || mimeType.startsWith("text/")) {
      const size = parseInt(meta.data.size ?? "0");
      if (size > 2 * 1024 * 1024) {
        return NextResponse.json({ type: "text", content: "[File too large to preview]", ext, name });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (drive.files.get as any)({ fileId, alt: "media" }, { responseType: "text" });
      return NextResponse.json({ type: "text", content: res.data as string, ext, name });
    }

    return NextResponse.json({ type: "unknown", name, ext });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
