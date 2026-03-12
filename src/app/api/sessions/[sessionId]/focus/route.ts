import { NextRequest } from "next/server";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectActiveClaudeSessions } from "@/lib/process-detector";
import { logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

function getTTY(pid: number): string | null {
  try {
    // ps -o tty= returns e.g. "ttys001" (not "s001")
    const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (!tty || tty === "??") return null;
    // Normalize to full path: "ttys001" → "/dev/ttys001"
    if (tty.startsWith("/dev/")) return tty;
    return `/dev/${tty}`;
  } catch {
    return null;
  }
}

function runAppleScript(script: string): string {
  const tmpFile = join(tmpdir(), `focus-${Date.now()}.applescript`);
  try {
    writeFileSync(tmpFile, script, "utf-8");
    return execFileSync("osascript", [tmpFile], {
      encoding: "utf-8",
      timeout: 6000,
    }).trim();
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function focusWithAppleScript(tty: string): { ok: boolean; error?: string } {
  // NOTE: "current tab" triggers AppleScript parse error (reserved word "current").
  // iTerm2: use "select s" directly; Terminal.app: use "selected tab".
  const script = `
set targetTTY to "${tty}"

-- Try iTerm2 (select session directly, avoids reserved-word "current tab")
tell application "System Events"
  set iTerm2Running to (count of (every process whose bundle identifier is "com.googlecode.iterm2")) > 0
end tell
if iTerm2Running then
  tell application "iTerm2"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is targetTTY then
            select s
            return "ok:iterm2"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if

-- Try Terminal.app
tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) is targetTTY then
        set selected tab of w to t
        set frontmost of w to true
        return "ok:terminal"
      end if
    end repeat
  end repeat
end tell

return "not_found"
`.trim();

  try {
    const result = runAppleScript(script);
    if (result.startsWith("ok:")) return { ok: true };
    return { ok: false, error: `Window not found for TTY ${tty} — is the terminal tab still open?` };
  } catch (err) {
    return { ok: false, error: `AppleScript error: ${String(err).slice(0, 300)}` };
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  if (process.platform !== "darwin") {
    return Response.json({ error: "Focus terminal is only supported on macOS" }, { status: 501 });
  }

  const processes = detectActiveClaudeSessions();
  const proc = processes.find((p) => p.sessionId === sessionId);

  if (!proc) {
    return Response.json({ error: "No active terminal process found for this session" }, { status: 404 });
  }

  const tty = getTTY(proc.pid);
  if (!tty) {
    return Response.json({ error: "Could not determine TTY — process may have exited" }, { status: 500 });
  }

  const result = focusWithAppleScript(tty);
  if (!result.ok) {
    return Response.json({ error: result.error, tty }, { status: 500 });
  }

  logAction("service", "focus_terminal", tty, sessionId);
  return Response.json({ ok: true, tty });
}
