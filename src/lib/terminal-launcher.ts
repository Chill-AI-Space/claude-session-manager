import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Wrap string for AppleScript */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Open a shell command in iTerm2 or Terminal.app.
 * Returns which terminal was used.
 */
export async function openInTerminal(shellCmd: string): Promise<{ terminal: string }> {
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

  await execFileAsync("osascript", ["-e", script]);
  return { terminal: useIterm ? "iTerm2" : "Terminal" };
}
