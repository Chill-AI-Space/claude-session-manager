import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type TerminalMatch = "tty" | "heuristic";
export type TerminalAction = "focus" | "close";

export function getTTY(pid: number): string | null {
  try {
    const tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (!tty || tty === "??") return null;
    if (tty.startsWith("/dev/")) return tty;
    return `/dev/${tty}`;
  } catch {
    return null;
  }
}

function runAppleScript(script: string): string {
  const tmpFile = join(tmpdir(), `terminal-control-${Date.now()}.applescript`);
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

function asAppleScriptString(value: string | null | undefined): string {
  return `"${(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function controlTerminalSession(args: {
  action: TerminalAction;
  tty?: string | null;
  sessionId: string;
  projectPath: string;
  projectName: string;
}): { ok: boolean; error?: string; reason?: "not_found" | "applescript"; match?: TerminalMatch } {
  const terminalTabAction = args.action === "focus"
    ? `
        activate
        set selected tab of w to t
        set frontmost of w to true
        return "ok:%MATCH%:terminal"
      `
    : `
        activate
        set selected tab of w to t
        set frontmost of w to true
        tell application "System Events" to keystroke "w" using command down
        return "ok:%MATCH%:terminal"
      `;

  const iTermAction = args.action === "focus"
    ? `
            activate
            select s
            return "ok:%MATCH%:iterm2"
      `
    : `
            activate
            select s
            tell application "System Events" to keystroke "w" using command down
            return "ok:%MATCH%:iterm2"
      `;

  const script = `
set targetTTY to ${asAppleScriptString(args.tty)}
set targetSessionId to ${asAppleScriptString(args.sessionId)}
set targetProjectPath to ${asAppleScriptString(args.projectPath)}
set targetProjectName to ${asAppleScriptString(args.projectName)}

on textMatches(candidateText, targetSessionId, targetProjectPath, targetProjectName)
  if candidateText is missing value then return false
  set candidateText to candidateText as text
  if targetSessionId is not "" and candidateText contains targetSessionId then return true
  if targetProjectPath is not "" and candidateText contains targetProjectPath then return true
  if targetProjectName is not "" and candidateText contains targetProjectName then return true
  return false
end textMatches

on sessionMatches(sessionName, sessionText, targetSessionId, targetProjectPath, targetProjectName)
  if my textMatches(sessionName, targetSessionId, targetProjectPath, targetProjectName) then return true
  if my textMatches(sessionText, targetSessionId, targetProjectPath, targetProjectName) then return true
  return false
end sessionMatches

tell application "System Events"
  set iTerm2Running to (count of (every process whose bundle identifier is "com.googlecode.iterm2")) > 0
end tell
if iTerm2Running then
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if targetTTY is not "" and (tty of s) is targetTTY then
${iTermAction.replace("%MATCH%", "tty")}
          end if
          try
            set sessionName to name of s
          on error
            set sessionName to ""
          end try
          try
            set sessionText to contents of s
          on error
            set sessionText to ""
          end try
          if my sessionMatches(sessionName, sessionText, targetSessionId, targetProjectPath, targetProjectName) then
${iTermAction.replace("%MATCH%", "heuristic")}
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if targetTTY is not "" and (tty of t) is targetTTY then
${terminalTabAction.replace("%MATCH%", "tty")}
      end if
      try
        set tabTitle to custom title of t
      on error
        set tabTitle to ""
      end try
      try
        set tabHistory to history of t
      on error
        set tabHistory to ""
      end try
      if my sessionMatches(tabTitle, tabHistory, targetSessionId, targetProjectPath, targetProjectName) then
${terminalTabAction.replace("%MATCH%", "heuristic")}
      end if
    end repeat
  end repeat
end tell

return "not_found"
`.trim();

  try {
    const result = runAppleScript(script);
    if (result.startsWith("ok:tty:")) return { ok: true, match: "tty" };
    if (result.startsWith("ok:heuristic:")) return { ok: true, match: "heuristic" };
    return {
      ok: false,
      reason: "not_found",
      error: `Window not found for session ${args.sessionId} — is the terminal tab still open?`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "applescript",
      error: `AppleScript error: ${String(err).slice(0, 300)}`,
    };
  }
}
