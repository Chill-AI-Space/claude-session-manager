import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Wrap string for AppleScript */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Open a shell command in a terminal window.
 * Supports macOS (iTerm2/Terminal.app), Windows (Windows Terminal/cmd.exe), and Linux (common terminals).
 * Returns which terminal was used.
 */
export async function openInTerminal(shellCmd: string, cwd?: string): Promise<{ terminal: string }> {
  if (process.platform === "win32") {
    return openInWindowsTerminal(shellCmd, cwd);
  }

  if (process.platform === "linux") {
    return openInLinuxTerminal(shellCmd, cwd);
  }

  if (process.platform !== "darwin") {
    throw new Error(`openInTerminal is not supported on ${process.platform}`);
  }

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

async function openInWindowsTerminal(shellCmd: string, cwd?: string): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd };

  // Try Windows Terminal first
  try {
    const args = cwd
      ? ["-d", cwd, "cmd", "/k", shellCmd]
      : ["cmd", "/k", shellCmd];
    spawn("wt.exe", args, spawnOpts).unref();
    return { terminal: "Windows Terminal" };
  } catch {
    // Windows Terminal not available, fall back to cmd.exe
  }

  const cmdShell = `cd /d "${cwd || "."}" && ${shellCmd}`;
  spawn("cmd.exe", ["/c", "start", "cmd", "/k", cmdShell], spawnOpts).unref();
  return { terminal: "cmd.exe" };
}

async function openInLinuxTerminal(shellCmd: string, cwd?: string): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd };
  const terminals = [
    { bin: "gnome-terminal", args: ["--", "bash", "-c", shellCmd] },
    { bin: "konsole", args: ["-e", "bash", "-c", shellCmd] },
    { bin: "xterm", args: ["-e", shellCmd] },
  ];

  for (const t of terminals) {
    try {
      spawn(t.bin, t.args, spawnOpts).unref();
      return { terminal: t.bin };
    } catch {
      continue;
    }
  }

  throw new Error("No supported terminal found (tried gnome-terminal, konsole, xterm)");
}
