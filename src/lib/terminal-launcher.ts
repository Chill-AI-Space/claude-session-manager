import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Wrap string for AppleScript */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Check if a binary exists on the system */
function hasBinary(name: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [name], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a shell command in a terminal window.
 * Supports macOS (iTerm2/Terminal.app), Windows (Windows Terminal/cmd.exe), and Linux (common terminals).
 * Returns which terminal was used.
 *
 * On Windows, prefer passing `executable` + `args` + `cwd` instead of a shell string
 * to avoid OEM codepage issues with non-ASCII paths.
 */
export type WindowsTerminalPref = "auto" | "wt" | "pwsh" | "cmd";

export async function openInTerminal(shellCmd: string, cwd?: string, opts?: { executable?: string; args?: string[]; preferredTerminal?: WindowsTerminalPref }): Promise<{ terminal: string }> {
  if (process.platform === "win32") {
    return openInWindowsTerminal(shellCmd, cwd, opts);
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

async function openInWindowsTerminal(shellCmd: string, cwd?: string, opts?: { executable?: string; args?: string[]; preferredTerminal?: WindowsTerminalPref }): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd, windowsHide: true };
  const pref = opts?.preferredTerminal || "auto";

  // When executable + args are provided, launch directly to avoid OEM codepage
  // issues with non-ASCII paths in shell command strings
  if (opts?.executable) {
    const exe = opts.executable;
    const args = opts.args || [];

    // PowerShell: open pwsh/powershell with the executable + args
    if (pref === "pwsh") {
      const psCmd = [exe, ...args].map(a => `"${a}"`).join(" ");
      const psExe = hasBinary("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
      spawn(psExe, ["-NoExit", "-Command", `Set-Location "${cwd || "."}"; & ${psCmd}`], { ...spawnOpts, windowsHide: false }).unref();
      return { terminal: psExe === "pwsh.exe" ? "PowerShell 7" : "PowerShell" };
    }

    // Windows Terminal (explicit or auto)
    if (pref === "wt" || (pref === "auto" && hasBinary("wt.exe"))) {
      const wtArgs = cwd
        ? ["-d", cwd, exe, ...args]
        : [exe, ...args];
      spawn("wt.exe", wtArgs, spawnOpts).unref();
      return { terminal: "Windows Terminal" };
    }

    // cmd.exe (explicit or auto fallback)
    const startArgs = ["/c", "start", "Claude Session", "/D", cwd || ".", exe, ...args];
    spawn("cmd.exe", startArgs, spawnOpts).unref();
    return { terminal: "cmd.exe" };
  }

  // Fallback: shell command string (legacy / macOS-style callers)
  if (pref === "pwsh") {
    const psExe = hasBinary("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
    spawn(psExe, ["-NoExit", "-Command", shellCmd], { ...spawnOpts, windowsHide: false }).unref();
    return { terminal: psExe === "pwsh.exe" ? "PowerShell 7" : "PowerShell" };
  }

  if (pref === "wt" || (pref === "auto" && hasBinary("wt.exe"))) {
    const args = cwd
      ? ["-d", cwd, "cmd", "/k", shellCmd]
      : ["cmd", "/k", shellCmd];
    spawn("wt.exe", args, spawnOpts).unref();
    return { terminal: "Windows Terminal" };
  }

  spawn("cmd.exe", ["/c", "start", "cmd", "/k", shellCmd], { ...spawnOpts, cwd: cwd || undefined }).unref();
  return { terminal: "cmd.exe" };
}

async function openInLinuxTerminal(shellCmd: string, cwd?: string): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd };
  const terminals = [
    { bin: "gnome-terminal", args: ["--", "bash", "-c", shellCmd] },
    { bin: "konsole", args: ["-e", "bash", "-c", shellCmd] },
    { bin: "xterm", args: ["-e", "bash", "-c", shellCmd] },
  ];

  for (const t of terminals) {
    if (hasBinary(t.bin)) {
      spawn(t.bin, t.args, spawnOpts).unref();
      return { terminal: t.bin };
    }
  }

  throw new Error("No supported terminal found (tried gnome-terminal, konsole, xterm)");
}
