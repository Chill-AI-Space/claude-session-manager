import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const cwd = session.project_path;
  const shellCmd = `cd "${cwd}" && claude --resume "${sessionId}"`;

  // Check if iTerm2 is running
  let useIterm = false;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'application "iTerm2" is running',
    ]);
    useIterm = stdout.trim() === "true";
  } catch {
    // iTerm2 not available
  }

  const script = useIterm
    ? [
        'tell application "iTerm2"',
        "  activate",
        "  set newWindow to (create window with default profile)",
        "  tell current session of newWindow",
        `    write text ${asString(shellCmd)}`,
        "  end tell",
        "end tell",
      ].join("\n")
    : [
        'tell application "Terminal"',
        "  activate",
        `  do script ${asString(shellCmd)}`,
        "end tell",
      ].join("\n");

  try {
    await execFileAsync("osascript", ["-e", script]);
    return Response.json({ ok: true, terminal: useIterm ? "iTerm2" : "Terminal" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

/** Wrap string for AppleScript: "hello \"world\"" */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
