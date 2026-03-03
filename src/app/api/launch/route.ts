import { NextRequest } from "next/server";
import { getSetting } from "@/lib/db";
import { openInTerminal } from "@/lib/terminal-launcher";
import { stat } from "fs/promises";
import os from "os";
import path from "path";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { path: dirPath } = await request.json();

  if (!dirPath || typeof dirPath !== "string") {
    return Response.json({ error: "Path is required" }, { status: 400 });
  }

  const resolved = path.resolve(dirPath);
  const homedir = os.homedir();

  if (!resolved.startsWith(homedir)) {
    return Response.json({ error: "Path must be within home directory" }, { status: 403 });
  }

  try {
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      return Response.json({ error: "Path is not a directory" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Path does not exist" }, { status: 404 });
  }

  const skipPermissions = getSetting("dangerously_skip_permissions") === "true";
  const skipFlag = skipPermissions ? " --dangerously-skip-permissions" : "";
  const shellCmd = `cd "${resolved}" && claude${skipFlag}`;

  try {
    const { terminal } = await openInTerminal(shellCmd);
    return Response.json({ ok: true, terminal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}
