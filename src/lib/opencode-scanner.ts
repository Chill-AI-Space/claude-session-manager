/**
 * Scanner for OpenCode AI agent sessions.
 * Reads from ~/.local/share/opencode/opencode.db and upserts into the sessions
 * table with agent_type='opencode'. Unlike Codex (which has a real rollout
 * JSONL path per thread), OpenCode has no file per session — jsonl_path is the
 * synthetic `opencode://<id>` marker and every message read goes straight to
 * OpenCode's own DB (see opencode-db.ts).
 *
 * Index text is deliberately light (title + first prompt + last message), so a
 * scan never parses OpenCode's multi-GB DB — only indexed per-session lookups.
 */
import type Database from "better-sqlite3";
import os from "os";
import { indexSessionContent } from "./db";
import {
  listIndexableOpencodeSessions,
  getOpencodeSessionIndexText,
  opencodeModelLabel,
  type OpencodeIndexRow,
  type OpencodeSessionIndexText,
} from "./opencode-db";
import { shouldSkipSessionIncremental } from "./scanner";
import * as dlog from "./debug-logger";

/** Convert a filesystem path to a project_dir key (same convention as Claude) */
function toProjectDir(p: string): string {
  return p.replace(/[\\/]/g, "-");
}

function resolveProjectPath(opencodeDir: string, existingProjectPath: string | undefined): string {
  const home = os.homedir();
  if (opencodeDir === home && existingProjectPath && existingProjectPath !== home) {
    return existingProjectPath;
  }
  return opencodeDir;
}

/** Injectable seams so tests never touch the real (multi-GB) OpenCode DB. */
export interface OpencodeScanDeps {
  listSessions?: () => OpencodeIndexRow[];
  getIndexText?: (sessionId: string) => OpencodeSessionIndexText | null;
  indexContent?: (sessionId: string, text: string) => void;
}

export async function scanOpencodeSessions(
  db: Database.Database,
  existingMtimes: Map<string, number>,
  mode: "full" | "incremental",
  upsertSession: Database.Statement,
  deps: OpencodeScanDeps = {}
): Promise<{ scanned: number; skipped: number }> {
  const listSessions = deps.listSessions ?? listIndexableOpencodeSessions;
  const getIndexText = deps.getIndexText ?? getOpencodeSessionIndexText;
  const indexContent = deps.indexContent ?? indexSessionContent;

  const sessions = listSessions();
  if (sessions.length === 0) return { scanned: 0, skipped: 0 };

  let scanned = 0;
  let skipped = 0;
  const existingFtsIds = new Set<string>();

  if (mode === "incremental") {
    const ftsRows = db
      .prepare("SELECT session_id FROM sessions_fts")
      .all() as { session_id: string }[];
    for (const row of ftsRows) {
      existingFtsIds.add(row.session_id);
    }
  }

  const existingProjectPaths = new Map(
    (
      db
        .prepare("SELECT session_id, project_path FROM sessions WHERE agent_type = 'opencode'")
        .all() as { session_id: string; project_path: string }[]
    ).map((row) => [row.session_id, row.project_path])
  );

  const setAgentStmt = db.prepare(
    `UPDATE sessions SET agent_type = 'opencode',
       model = COALESCE(model, ?),
       generated_title = COALESCE(generated_title, ?)
     WHERE session_id = ?`
  );

  // Chunked: every per-session read is a random page touch in OpenCode's
  // multi-GB DB — a cold first scan of hundreds of sessions would otherwise
  // block the event loop for a minute straight (a request-served sidebar would
  // hang with it). One transaction per chunk, event loop breathes between chunks.
  const CHUNK_SIZE = 25;

  for (let i = 0; i < sessions.length; i += CHUNK_SIZE) {
    const chunk = sessions.slice(i, i + CHUNK_SIZE);
    const ftsQueue: Array<{ sessionId: string; text: string }> = [];

    const insertBatch = db.transaction(() => {
      for (const session of chunk) {
        const timeUpdated = session.time_updated;

        if (mode === "incremental" && existingMtimes.has(session.id)) {
          const existing = existingMtimes.get(session.id)!;
          const hasFtsIndex = existingFtsIds.has(session.id);
          if (shouldSkipSessionIncremental(existing, timeUpdated, hasFtsIndex)) {
            skipped++;
            continue;
          }
        }

        const text = getIndexText(session.id);
        const cwd = resolveProjectPath(session.directory, existingProjectPaths.get(session.id));
        const now = new Date().toISOString();

        const firstPrompt = text?.firstPrompt?.slice(0, 1000) ?? null;
        const lastMessage = text?.lastMessage?.slice(-1000) ?? firstPrompt;
        const title = session.title || null;
        const modelLabel = opencodeModelLabel(session.model);

        upsertSession.run({
          session_id: session.id,
          jsonl_path: `opencode://${session.id}`,
          project_dir: toProjectDir(cwd),
          project_path: cwd,
          git_branch: null,
          claude_version: null,
          // `model` on conflict is COALESCE(new, existing): null keeps whatever the
          // start route stored (the OpenCode profile id) — only brand-new rows get
          // the parsed `provider/model` label via the UPDATE below.
          model: null,
          first_prompt: firstPrompt,
          last_message: lastMessage,
          last_message_role: text?.lastMessageRole ?? null,
          has_result: text?.lastMessageRole === "assistant" ? 1 : 0,
          message_count: text?.messageCount ?? 0,
          total_input_tokens: session.tokens_input ?? 0,
          total_output_tokens: session.tokens_output ?? 0,
          created_at: new Date(session.time_created).toISOString(),
          modified_at: new Date(timeUpdated).toISOString(),
          file_mtime: timeUpdated,
          file_size: 0,
          last_scanned_at: now,
        });

        setAgentStmt.run(modelLabel, title, session.id);

        const searchText = [title, firstPrompt, lastMessage].filter(Boolean).join("\n").slice(0, 20_000);
        if (searchText) ftsQueue.push({ sessionId: session.id, text: searchText });
        scanned++;
      }
    });

    insertBatch();
    for (const { sessionId, text } of ftsQueue) {
      indexContent(sessionId, text);
    }

    if (i + CHUNK_SIZE < sessions.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (scanned > 0 || skipped > 0) {
    dlog.info("opencode-scanner", `opencode scan: ${scanned} scanned, ${skipped} skipped`);
  }

  return { scanned, skipped };
}
