import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (process.platform !== "darwin") {
    return Response.json({ error: "Only supported on macOS" }, { status: 400 });
  }

  const { filePath, cwd, action = "reveal" } = await request.json();
  if (!filePath || typeof filePath !== "string") {
    return Response.json({ error: "filePath required" }, { status: 400 });
  }

  // Resolve relative paths against project cwd
  const resolved = filePath.startsWith("/") || filePath.startsWith("~")
    ? filePath
    : cwd
      ? path.resolve(cwd, filePath)
      : filePath;

  const args = action === "reveal" ? ["-R", resolved] : [resolved];

  return new Promise<Response>((resolve) => {
    const proc = spawn("open", args);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Response.json({ ok: true, resolved }));
      } else {
        resolve(Response.json({ error: `open exited ${code}` }, { status: 500 }));
      }
    });
    proc.on("error", (err) => {
      resolve(Response.json({ error: err.message }, { status: 500 }));
    });
  });
}
