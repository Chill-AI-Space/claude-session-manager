import { NextRequest, NextResponse } from "next/server";
import { readFileSync, statSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const TEXT_EXTS = new Set([
  "md", "mdx", "txt", "json", "yaml", "yml", "toml", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h",
  "css", "scss", "html", "xml", "sh", "bash", "zsh",
  "sql", "graphql", "prisma",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

const MAX_TEXT_BYTES = 500_000; // 500KB

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const ext = path.extname(filePath).toLowerCase().slice(1);

  try {
    const stat = statSync(filePath);

    if (IMAGE_EXTS.has(ext)) {
      const buf = readFileSync(filePath);
      const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return new NextResponse(buf, { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=60" } });
    }

    if (ext === "pdf") {
      return NextResponse.json({ type: "pdf", name: path.basename(filePath) });
    }

    if (TEXT_EXTS.has(ext) || stat.size < MAX_TEXT_BYTES) {
      if (stat.size > MAX_TEXT_BYTES) {
        return NextResponse.json({ type: "text", content: "File too large to preview", ext, truncated: true });
      }
      const content = readFileSync(filePath, "utf-8");
      return NextResponse.json({ type: "text", content, ext });
    }

    return NextResponse.json({ type: "unknown", name: path.basename(filePath), ext });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
