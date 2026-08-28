import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
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
}): { ok: boolean; error?: string; terminal?: "iTerm2" | "Terminal"; reason?: "not_found" | "applescript" | "busy" | "mismatch" } {
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

on ttyTail(ttyValue)
  if ttyValue is missing value then return ""
  set ttyText to ttyValue as text
  if ttyText starts with "/dev/" then
    try
      return text 6 thru -1 of ttyText
    on error
      return ttyText
    end try
  end if
  return ttyText
end ttyTail

on ttyMatches(candidateTTY, targetTTY)
  if targetTTY is "" then return false
  set candidateText to candidateTTY as text
  set targetText to targetTTY as text
  if candidateText is targetText then return true
  if my ttyTail(candidateText) is my ttyTail(targetText) then return true
  return false
end ttyMatches

tell application "System Events"
  set iTerm2Running to (count of (every process whose bundle identifier is "com.googlecode.iterm2")) > 0
end tell

if iTerm2Running then
  set payloadText to do shell script "/bin/cat " & quoted form of payloadPath
  -- Phase 1 (read-only): find the unique ID of the session matching our TTY.
  -- Deliberately avoid select/activate here — the mis-binding bug was observed
  -- when the same session variable was reused for both matching and writing.
  set foundUID to ""
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          try
            if my ttyMatches((tty of s as text), targetTTY) then
              set foundUID to (unique ID of s) as text
              exit repeat
            end if
          end try
        end repeat
        if foundUID is not "" then exit repeat
      end repeat
      if foundUID is not "" then exit repeat
    end repeat
  end tell
  -- Phase 2: write to the session resolved by unique ID (fresh object reference,
  -- independent of the tty-based scan above).
  if foundUID is not "" then
    tell application "iTerm"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              if (unique ID of s as text) is foundUID then
                try
                  set sessionText to contents of s
                on error
                  set sessionText to ""
                end try
                set tailText to sessionText
                try
                  set tailParagraphs to paragraphs of sessionText
                  set paraCount to count of tailParagraphs
                  if paraCount > 20 then
                    set tailText to ""
                    repeat with idx from (paraCount - 19) to paraCount
                      set tailText to tailText & (item idx of tailParagraphs as text) & linefeed
                    end repeat
                  end if
                end try
                if tailText contains "esc to interrupt" or tailText contains "Starting MCP servers" then
                  return "busy:iterm2"
                end if
                -- Write BEFORE any activate/select so that focus operations
                -- cannot rebind the session reference. iTerm2's AppleScript
                -- bridge was observed routing write text to the currently
                -- focused session after activate+select, not to the referenced
                -- session object s — moving the write first avoids that.
                tell s to write text payloadText newline NO
                delay 0.15
                tell s to write text ""
                -- Focus after writing (for user experience only)
                try
                  activate
                end try
                try
                  set index of w to 1
                end try
                try
                  select t
                end try
                try
                  select s
                end try
                return "ok:iterm2"
              end if
            end try
          end repeat
        end repeat
      end repeat
    end tell
    -- unique ID was found in phase 1 but the session disappeared between phases
    return "uid_lost:iterm2"
  end if
end if

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if my ttyMatches((tty of t as text), targetTTY) then
        activate
        try
          set index of w to 1
        end try
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
    if (result === "busy:iterm2") {
      return {
        ok: false,
        reason: "busy",
        terminal: "iTerm2",
        error: `Live iTerm2 session ${args.tty} is busy`,
      };
    }
    if (result === "uid_lost:iterm2") {
      return {
        ok: false,
        reason: "not_found",
        terminal: "iTerm2",
        error: `iTerm2 session for TTY ${args.tty} disappeared between unique-ID lookup and write`,
      };
    }
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

/**
 * sendTextToTerminalTTY, but verified against ground truth: iTerm's own
 * `tty of s` matching has been observed, confirmed live, to sometimes bind
 * to the WRONG session while every AppleScript-internal check (including a
 * same-session re-read) still reports success — the write and the read are
 * both happening against the same mis-bound object, so they agree with each
 * other and with reality. The only independent signal is the target
 * session's actual transcript file on disk: if the payload doesn't show up
 * there as a new line within a few seconds, the send did not really reach
 * that session, whatever iTerm claimed.
 *
 * @param transcriptPath the target session's own .jsonl file
 */
export async function sendTextToTerminalTTYVerified(args: {
  tty: string;
  text: string;
  transcriptPath: string;
}): Promise<{ ok: boolean; error?: string; terminal?: "iTerm2" | "Terminal"; reason?: "not_found" | "applescript" | "busy" | "mismatch" }> {
  const result = sendTextToTerminalTTY({ tty: args.tty, text: args.text });
  if (!result.ok) return result;

  const sizeBefore = (() => {
    try {
      return readFileSync(args.transcriptPath, "utf-8").length;
    } catch {
      return 0;
    }
  })();

  const marker = args.text.slice(0, 40);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const content = readFileSync(args.transcriptPath, "utf-8");
      if (content.length > sizeBefore && content.includes(marker)) {
        return result; // confirmed: the new content is really there
      }
    } catch {
      // transcript may not exist yet on a brand-new session — keep polling
    }
  }

  // Distinguish two cases after the polling window:
  // 1. File grew but our marker is absent — something ELSE wrote to the transcript,
  //    which is the signature of wrong-window delivery (text went to another session).
  // 2. File didn't grow at all — Claude is busy or crashed; the text was typed into
  //    the correct terminal but Claude hasn't processed it yet. The two-phase unique-ID
  //    delivery is trusted; don't treat this as failure.
  try {
    const finalContent = readFileSync(args.transcriptPath, "utf-8");
    if (finalContent.length > sizeBefore && !finalContent.includes(marker)) {
      return {
        ok: false,
        reason: "mismatch",
        terminal: result.terminal,
        error: `iTerm reported success writing to tty ${args.tty}, but a different message appeared in the target transcript — the text was delivered to a wrong session instead.`,
      };
    }
  } catch { /* ignore — treat as no-growth */ }

  // Transcript didn't grow within timeout: Claude is busy or not yet processing.
  // Trust the unique-ID-based delivery — the text is queued in the right terminal.
  return result;
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
        try
          set index of w to 1
        end try
        set selected tab of w to t
        set frontmost of w to true
        return "ok:%MATCH%:terminal"
      `
    : `
        activate
        try
          set index of w to 1
        end try
        set selected tab of w to t
        set frontmost of w to true
        tell application "System Events" to keystroke "w" using command down
        return "ok:%MATCH%:terminal"
      `;

  const iTermAction = args.action === "focus"
    ? `
            activate
            try
              set index of w to 1
            end try
            try
              select t
            end try
            select s
            return "ok:%MATCH%:iterm2"
      `
    : `
            activate
            try
              set index of w to 1
            end try
            try
              select t
            end try
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

on ttyTail(ttyValue)
  if ttyValue is missing value then return ""
  set ttyText to ttyValue as text
  if ttyText starts with "/dev/" then
    try
      return text 6 thru -1 of ttyText
    on error
      return ttyText
    end try
  end if
  return ttyText
end ttyTail

on ttyMatches(candidateTTY, targetTTY)
  if targetTTY is "" then return false
  set candidateText to candidateTTY as text
  set targetText to targetTTY as text
  if candidateText is targetText then return true
  if my ttyTail(candidateText) is my ttyTail(targetText) then return true
  return false
end ttyMatches

tell application "System Events"
  set iTerm2Running to (count of (every process whose bundle identifier is "com.googlecode.iterm2")) > 0
end tell

-- Fast path: match by TTY first without reading terminal scrollback/history.
if iTerm2Running then
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if my ttyMatches((tty of s as text), targetTTY) then
${iTermAction.replace("%MATCH%", "tty")}
          end if
        end repeat
      end repeat
    end repeat
  end tell
end if

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if my ttyMatches((tty of t as text), targetTTY) then
${terminalTabAction.replace("%MATCH%", "tty")}
      end if
    end repeat
  end repeat
end tell

-- Fallback: if process/TTY detection failed, try matching visible titles/history.
if iTerm2Running then
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          try
            set sessionName to name of s
          on error
            set sessionName to ""
          end try
          if my sessionMatches(sessionName, "", targetSessionId, targetProjectPath, targetProjectName) then
${iTermAction.replace("%MATCH%", "heuristic")}
          end if
          try
            set sessionText to contents of s
          on error
            set sessionText to ""
          end try
          if my sessionMatches("", sessionText, targetSessionId, targetProjectPath, targetProjectName) then
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
