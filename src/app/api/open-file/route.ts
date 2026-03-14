import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { filePath, cwd, action = "reveal" } = await request.json();
  if (!filePath || typeof filePath !== "string") {
    return Response.json({ error: "filePath required" }, { status: 400 });
  }

  // Resolve relative paths against project cwd
  let resolved = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)
      ? filePath
      : cwd
        ? path.resolve(cwd, filePath)
        : filePath;

  // Normalize to resolve ".." traversal and check boundary
  resolved = path.resolve(resolved);
  const home = os.homedir();
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return Response.json({ error: "Access denied: path outside home directory" }, { status: 403 });
  }

  return new Promise<Response>((resolve) => {
    let proc;
    if (process.platform === "win32") {
      // Windows: use explorer to reveal file
      // explorer expects "/select,path" as a single argument
      proc = spawn("explorer", action === "reveal" ? [`/select,${resolved}`] : [resolved], { windowsHide: true });
    } else if (process.platform === "darwin") {
      // macOS: use open command
      const args = action === "reveal" ? ["-R", resolved] : [resolved];
      proc = spawn("open", args);
    } else {
      // Linux: use xdg-open on the directory
      proc = spawn("xdg-open", [action === "reveal" ? path.dirname(resolved) : resolved]);
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Response.json({ ok: true, resolved }));
      } else {
        resolve(Response.json({ error: `Process exited ${code}` }, { status: 500 }));
      }
    });
    proc.on("error", (err) => {
      resolve(Response.json({ error: err.message }, { status: 500 }));
    });
  });
}
