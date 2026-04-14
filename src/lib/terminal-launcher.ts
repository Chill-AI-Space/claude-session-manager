import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

export interface TerminalOptions {
  cwd?: string;
  /** Auto-close the terminal window when the command finishes (macOS only) */
  autoClose?: boolean;
}

/** Wrap string for AppleScript */
function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * For long shell commands, write to a temp script and return a short invocation.
 * AppleScript `do script` / `write text` silently fails on very long strings (~2000+ chars).
 */
function wrapLongCommand(shellCmd: string): string {
  if (shellCmd.length <= 1200) return shellCmd;
  const tmpFile = path.join(os.tmpdir(), `csm-launch-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, `#!/bin/bash\n${shellCmd}\n`, { mode: 0o755 });
  return `bash ${tmpFile}`;
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
 */
export async function openInTerminal(shellCmd: string, opts?: TerminalOptions | string): Promise<{ terminal: string }> {
  // Backwards compat: old signature was (shellCmd, cwd?)
  const options: TerminalOptions = typeof opts === "string" ? { cwd: opts } : (opts ?? {});

  if (process.platform === "win32") {
    return openInWindowsTerminal(shellCmd, options.cwd);
  }

  if (process.platform === "linux") {
    return openInLinuxTerminal(shellCmd, options.cwd);
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

  if (options.autoClose) {
    return openMacAutoClose(shellCmd, useIterm);
  }

  const safeCmd = wrapLongCommand(shellCmd);
  const script = useIterm
    ? [
        'tell application "iTerm2"',
        "  activate",
        "  set newWindow to (create window with default profile)",
        "  tell current session of newWindow",
        `    write text ${asString(safeCmd)}`,
        "  end tell",
        "end tell",
      ].join("\n")
    : [
        'tell application "Terminal"',
        "  activate",
        `  do script ${asString(safeCmd)}`,
        "end tell",
      ].join("\n");

  await execFileAsync("osascript", ["-e", script]);
  return { terminal: useIterm ? "iTerm2" : "Terminal" };
}

/**
 * Open command in terminal and auto-close the window when it finishes.
 * Runs a background osascript that polls the tab and closes it when done.
 */
function openMacAutoClose(shellCmd: string, useIterm: boolean): Promise<{ terminal: string }> {
  // Append "; exit" so the shell exits when the command finishes
  const cmdWithExit = shellCmd + " ; exit";

  const script = useIterm
    ? [
        'tell application "iTerm2"',
        "  activate",
        "  set newWindow to (create window with default profile)",
        "  tell current session of newWindow",
        `    write text ${asString(cmdWithExit)}`,
        "  end tell",
        "end tell",
        "",
        "-- Poll until session ends, then close window",
        "repeat",
        "  delay 10",
        "  try",
        '    tell application "iTerm2"',
        "      if newWindow is not in windows then exit repeat",
        "      tell current session of newWindow",
        "        if (is at shell prompt) then",
        "          close newWindow",
        "          exit repeat",
        "        end if",
        "      end tell",
        "    end tell",
        "  on error",
        "    exit repeat",
        "  end try",
        "end repeat",
      ].join("\n")
    : [
        'tell application "Terminal"',
        "  activate",
        `  set theTab to do script ${asString(cmdWithExit)}`,
        "end tell",
        "",
        "-- Poll until tab is no longer busy, then close its window",
        "repeat",
        "  delay 10",
        "  try",
        '    tell application "Terminal"',
        "      if not (exists theTab) then exit repeat",
        "      if not (busy of theTab) then",
        "        set theWindow to (first window whose tabs contains theTab)",
        "        close theWindow",
        "        exit repeat",
        "      end if",
        "    end tell",
        "  on error",
        "    exit repeat",
        "  end try",
        "end repeat",
      ].join("\n");

  // Run in background — don't block the caller
  const proc = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  return Promise.resolve({ terminal: useIterm ? "iTerm2" : "Terminal" });
}

async function openInWindowsTerminal(shellCmd: string, cwd?: string): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd, windowsHide: true };

  // Try Windows Terminal first (check it actually exists)
  if (hasBinary("wt.exe")) {
    const args = cwd
      ? ["-d", cwd, "cmd", "/k", shellCmd]
      : ["cmd", "/k", shellCmd];
    spawn("wt.exe", args, spawnOpts).unref();
    return { terminal: "Windows Terminal" };
  }

  // Fallback to cmd.exe — use cwd spawn option instead of cd /d to avoid injection
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
