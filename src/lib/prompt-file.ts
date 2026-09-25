import fs from "fs";
import os from "os";
import path from "path";

/** Shell-quote a string for embedding as a single argument in a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write a prompt (which may be long and/or multi-line) to a temp file so it never
 * has to be embedded in the shell command typed into a terminal.
 *
 * iTerm2's AppleScript `write text` silently truncates long strings (~1024 chars);
 * a truncated `--prompt '<unterminated` leaves the shell stuck at `quote>`. Loading
 * the prompt from a file keeps the typed command short regardless of prompt size.
 */
export function writeTempPromptFile(prompt: string, prefix = "csm-prompt"): string {
  const promptPath = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(promptPath, prompt, "utf8");
  return promptPath;
}

/**
 * Shell fragment that loads a temp prompt file into `$PROMPT`, then removes it.
 *
 * `cat`'s exit code gates the `&&` chain (so a failed read aborts the launch),
 * while `rm` is wrapped in `{ …; true; }` so its exit code can never block `exec`.
 */
export function buildPromptLoader(promptPath: string, varName = "PROMPT"): string {
  const fileVar = `${varName}_FILE`;
  return `${fileVar}=${shellQuote(promptPath)} && ${varName}="$(cat "$${fileVar}")" && { rm -f "$${fileVar}"; true; }`;
}
