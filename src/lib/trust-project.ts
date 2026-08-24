/**
 * Pre-accept Claude Code's one-time "is this a project you trust?" dialog
 * for a project path, so a programmatically-launched interactive terminal
 * session (nobody there to press Enter) doesn't hang on it forever.
 *
 * Same trust level as the user manually running `claude` in that folder and
 * answering "1. Yes" themselves — this only ever runs for a path the user's
 * own session-manager UI was just asked, explicitly, to start a session in.
 */
import { readFileSync, writeFileSync, renameSync } from "fs";
import os from "os";
import path from "path";

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

export function ensureProjectTrusted(projectPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(CLAUDE_JSON_PATH, "utf-8");
  } catch {
    return; // no ~/.claude.json yet — nothing to pre-seed, let the CLI create it normally
  }

  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(raw);
  } catch {
    return; // don't touch a file we can't safely parse
  }

  if (!config.projects) config.projects = {};
  const existing = config.projects[projectPath];

  if (existing?.hasTrustDialogAccepted === true) return; // already trusted, nothing to do

  config.projects[projectPath] = { ...existing, hasTrustDialogAccepted: true };

  const tmpPath = `${CLAUDE_JSON_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(config));
  renameSync(tmpPath, CLAUDE_JSON_PATH);
}
