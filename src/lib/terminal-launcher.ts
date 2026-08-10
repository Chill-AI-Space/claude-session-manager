import { execFile, execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

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

function hasMacApp(appName: string): boolean {
  if (process.platform !== "darwin") return false;
  return (
    fs.existsSync(path.join("/Applications", `${appName}.app`)) ||
    fs.existsSync(path.join(os.homedir(), "Applications", `${appName}.app`))
  );
}

function isMacProcessRunning(processName: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("pgrep", ["-x", processName], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function startDetachedConsole(executable: string, args: string[], cwd?: string): void {
  const startArgs = ["/c", "start", "\"\""];
  if (cwd) {
    startArgs.push("/D", cwd);
  }
  startArgs.push(executable, ...args);
  spawn("cmd.exe", startArgs, {
    detached: true,
    stdio: "ignore",
    cwd,
    windowsHide: true,
  }).unref();
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
export interface WindowsLaunchOptions {
  executable?: string;
  args?: string[];
  preferredTerminal?: WindowsTerminalPref;
}

export async function openInTerminal(
  shellCmd: string,
  opts?: TerminalOptions | string,
  windowsOpts?: WindowsLaunchOptions
): Promise<{ terminal: string }> {
  const options: TerminalOptions = typeof opts === "string" ? { cwd: opts } : (opts ?? {});

  if (process.platform === "win32") {
    const launchOpts = typeof opts === "string" ? windowsOpts : undefined;
    return openInWindowsTerminal(shellCmd, options.cwd, launchOpts);
  }

  if (process.platform === "linux") {
    return openInLinuxTerminal(shellCmd, options.cwd);
  }

  if (process.platform !== "darwin") {
    throw new Error(`openInTerminal is not supported on ${process.platform}`);
  }

  const useIterm = hasMacApp("iTerm");
  const iTermWasRunning = useIterm && isMacProcessRunning("iTerm2");

  if (options.autoClose) {
    return openMacAutoClose(shellCmd, useIterm, iTermWasRunning);
  }

  const safeCmd = wrapLongCommand(shellCmd);
  const script = useIterm
    ? [
        'tell application "iTerm"',
        "  activate",
        `  if ${iTermWasRunning ? "true" : "false"} then`,
        "    set newWindow to (create window with default profile)",
        "  else",
        "    delay 0.2",
        "    if (count of windows) = 0 then",
        "      set newWindow to (create window with default profile)",
        "    else",
        "      set newWindow to current window",
        "    end if",
        "  end if",
        "  tell current session of newWindow",
        `    write text ${asString(safeCmd)}`,
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

function openMacAutoClose(
  shellCmd: string,
  useIterm: boolean,
  iTermWasRunning: boolean
): Promise<{ terminal: string }> {
  const cmdWithExit = `${shellCmd} ; exit`;
  const script = useIterm
    ? [
        'tell application "iTerm"',
        "  activate",
        `  if ${iTermWasRunning ? "true" : "false"} then`,
        "    set newWindow to (create window with default profile)",
        "  else",
        "    delay 0.2",
        "    if (count of windows) = 0 then",
        "      set newWindow to (create window with default profile)",
        "    else",
        "      set newWindow to current window",
        "    end if",
        "  end if",
        "  tell current session of newWindow",
        `    write text ${asString(cmdWithExit)}`,
        "  end tell",
        "end tell",
        "",
        "repeat",
        "  delay 10",
        "  try",
        '    tell application "iTerm"',
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

  const proc = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return Promise.resolve({ terminal: useIterm ? "iTerm2" : "Terminal" });
}

async function openInWindowsTerminal(
  shellCmd: string,
  cwd?: string,
  opts?: WindowsLaunchOptions
): Promise<{ terminal: string }> {
  const spawnOpts = { detached: true, stdio: "ignore" as const, cwd, windowsHide: true };
  // wt.exe is the visible terminal window itself — hiding it (windowsHide) would
  // launch Windows Terminal invisibly, which looks like "nothing happened".
  const visibleSpawnOpts = { ...spawnOpts, windowsHide: false };
  const pref = opts?.preferredTerminal || "auto";

  // When executable + args are provided, launch directly to avoid OEM codepage
  // issues with non-ASCII paths in shell command strings
  if (opts?.executable) {
    const exe = opts.executable;
    const args = opts.args || [];

    const openInPowerShell = () => {
      const psExe = hasBinary("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
      const psArgs = args.map(psQuote).join(", ");
      const script = [
        `Set-Location -LiteralPath ${psQuote(cwd || ".")}`,
        `$csmArgs = @(${psArgs})`,
        `& ${psQuote(exe)} @csmArgs`,
      ].join("; ");
      const encoded = encodePowerShellCommand(script);
      startDetachedConsole(psExe, ["-NoExit", "-EncodedCommand", encoded], cwd || undefined);
      return { terminal: psExe === "pwsh.exe" ? "PowerShell 7" : "PowerShell" };
    };

    if (pref === "pwsh") {
      return openInPowerShell();
    }

    if (pref === "wt" || (pref === "auto" && hasBinary("wt.exe"))) {
      const wtArgs = cwd
        ? ["-d", cwd, exe, ...args]
        : [exe, ...args];
      spawn("wt.exe", wtArgs, visibleSpawnOpts).unref();
      return { terminal: "Windows Terminal" };
    }

    if (pref !== "cmd") {
      return openInPowerShell();
    }

    const startArgs = ["/c", "start", "Claude Session", "/D", cwd || ".", exe, ...args];
    spawn("cmd.exe", startArgs, { ...spawnOpts, cwd: cwd || undefined }).unref();
    return { terminal: "cmd.exe" };
  }

  // Fallback: shell command string (legacy / macOS-style callers)
  if (pref === "pwsh") {
    const psExe = hasBinary("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
    const encoded = encodePowerShellCommand(shellCmd);
    startDetachedConsole(psExe, ["-NoExit", "-EncodedCommand", encoded], cwd || undefined);
    return { terminal: psExe === "pwsh.exe" ? "PowerShell 7" : "PowerShell" };
  }

  if (pref === "wt" || (pref === "auto" && hasBinary("wt.exe"))) {
    const args = cwd
      ? ["-d", cwd, "cmd", "/k", shellCmd]
      : ["cmd", "/k", shellCmd];
    spawn("wt.exe", args, visibleSpawnOpts).unref();
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
