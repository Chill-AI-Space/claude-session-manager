import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type TerminalMatch = "tty" | "heuristic";
export type TerminalAction = "focus" | "close";

function writeTempTextFile(text: string): string {
  const tmpFile = join(tmpdir(), `terminal-input-${Date.now()}.txt`);
  writeFileSync(tmpFile, text, "utf-8");
  return tmpFile;
}

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

export function sendTextToTerminalTTY(args: {
  tty: string;
  text: string;
}): { ok: boolean; error?: string; terminal?: "iTerm2" | "Terminal"; reason?: "not_found" | "applescript" } {
  const payloadPath = writeTempTextFile(args.text);
  const script = `
set targetTTY to ${asAppleScriptString(args.tty)}
set payloadPath to ${asAppleScriptString(payloadPath)}

on pastePayloadForProcess(payloadPath, processName, shouldSubmit)
  set savedClipboard to missing value
  try
    set savedClipboard to the clipboard
  end try
  do shell script "/usr/bin/pbcopy < " & quoted form of payloadPath
  delay 0.15
  tell application "System Events"
    tell process processName
      click menu item "Paste" of menu "Edit" of menu bar 1
      if shouldSubmit then
        delay 0.15
        key code 36
      end if
    end tell
  end tell
  if savedClipboard is not missing value then
    try
      set the clipboard to savedClipboard
    end try
  end if
end pastePayloadForProcess

tell application "System Events"
  set iTerm2Running to (count of (every process whose bundle identifier is "com.googlecode.iterm2")) > 0
end tell

if iTerm2Running then
  set payloadText to do shell script "/bin/cat " & quoted form of payloadPath
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s as text) is equal to targetTTY then
            activate
            select s
            delay 0.15
            tell s to write text payloadText
            return "ok:iterm2"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) is targetTTY then
        activate
        set selected tab of w to t
        set frontmost of w to true
        delay 0.15
        my pastePayloadForProcess(payloadPath, "Terminal", true)
        return "ok:terminal"
      end if
    end repeat
  end repeat
end tell

return "not_found"
`.trim();

  try {
    const result = runAppleScript(script);
    if (result === "ok:iterm2") return { ok: true, terminal: "iTerm2" };
    if (result === "ok:terminal") return { ok: true, terminal: "Terminal" };
    return {
      ok: false,
      reason: "not_found",
      error: `Live terminal not found for TTY ${args.tty}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "applescript",
      error: `AppleScript error: ${String(err).slice(0, 300)}`,
    };
  } finally {
    try { unlinkSync(payloadPath); } catch { /* ignore */ }
  }
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
  tell application "iTerm"
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
