import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

const REPORTS_DIR = path.join(process.cwd(), "data", "reports");

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^report-\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid report ID" }, { status: 400 });
  }

  const filePath = path.join(REPORTS_DIR, `${id}.html`);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const html = fs.readFileSync(filePath, "utf-8");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
