import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getProjectIcon, deleteProjectIcon } from "@/lib/project-icon";

export const dynamic = "force-dynamic";

/** GET /api/projects/icon?path=/path/to/project — returns the icon image */
export async function GET(req: NextRequest) {
  const projectPath = req.nextUrl.searchParams.get("path");
  if (!projectPath) {
    return NextResponse.json({ error: "path parameter required" }, { status: 400 });
  }

  try {
    const { filePath, contentType } = await getProjectIcon(projectPath);
    const buffer = fs.readFileSync(filePath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400", // cache 24h
      },
    });
  } catch (e) {
    console.error("Project icon error:", e);
    return NextResponse.json({ error: "Failed to get icon" }, { status: 500 });
  }
}

/** POST /api/projects/icon?path=/path/to/project — regenerate icon */
export async function POST(req: NextRequest) {
  const projectPath = req.nextUrl.searchParams.get("path");
  if (!projectPath) {
    return NextResponse.json({ error: "path parameter required" }, { status: 400 });
  }

  let context: string | undefined;
  try {
    const body = await req.json();
    context = body.context;
  } catch {
    // no body is fine
  }

  try {
    // Delete old icon first
    deleteProjectIcon(projectPath);
    const { filePath, contentType } = await getProjectIcon(projectPath, {
      regenerate: true,
      context,
    });
    const buffer = fs.readFileSync(filePath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    console.error("Project icon regeneration error:", e);
    return NextResponse.json({ error: "Failed to regenerate icon" }, { status: 500 });
  }
}
