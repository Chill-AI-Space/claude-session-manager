import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { scanOpencodeSessions, type OpencodeScanDeps } from "../opencode-scanner";
import type { OpencodeIndexRow, OpencodeSessionIndexText } from "../opencode-db";

// Mirrors the shared upsert in scanner.ts — the schema subset it touches.
const UPSERT_SQL = `
  INSERT INTO sessions (
    session_id, jsonl_path, project_dir, project_path,
    git_branch, claude_version, model, first_prompt, last_message, last_message_role,
    has_result, message_count, total_input_tokens, total_output_tokens,
    created_at, modified_at, file_mtime, file_size, last_scanned_at
  ) VALUES (
    @session_id, @jsonl_path, @project_dir, @project_path,
    @git_branch, @claude_version, @model, @first_prompt, @last_message, @last_message_role,
    @has_result, @message_count, @total_input_tokens, @total_output_tokens,
    @created_at, @modified_at, @file_mtime, @file_size, @last_scanned_at
  )
  ON CONFLICT(session_id) DO UPDATE SET
    jsonl_path = @jsonl_path,
    project_dir = @project_dir,
    project_path = @project_path,
    git_branch = COALESCE(@git_branch, sessions.git_branch),
    claude_version = COALESCE(@claude_version, sessions.claude_version),
    model = COALESCE(@model, sessions.model),
    first_prompt = COALESCE(@first_prompt, sessions.first_prompt),
    last_message = COALESCE(@last_message, sessions.last_message),
    last_message_role = COALESCE(@last_message_role, sessions.last_message_role),
    has_result = @has_result,
    message_count = @message_count,
    total_input_tokens = @total_input_tokens,
    total_output_tokens = @total_output_tokens,
    created_at = @created_at,
    modified_at = @modified_at,
    file_mtime = @file_mtime,
    file_size = @file_size,
    last_scanned_at = @last_scanned_at
`;

function createSessionsDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      jsonl_path TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      project_path TEXT NOT NULL,
      git_branch TEXT,
      claude_version TEXT,
      model TEXT,
      first_prompt TEXT,
      last_message TEXT,
      last_message_role TEXT,
      generated_title TEXT,
      agent_type TEXT,
      has_result INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      last_scanned_at TEXT NOT NULL
    );
    CREATE TABLE sessions_fts (session_id TEXT, content TEXT);
  `);
  return { db, upsert: db.prepare(UPSERT_SQL) };
}

const row = (overrides: Partial<OpencodeIndexRow> = {}): OpencodeIndexRow => ({
  id: "ses_test1",
  directory: "/tmp/some-project",
  title: "Тестовый заголовок",
  time_created: 1_700_000_000_000,
  time_updated: 1_700_000_500_000,
  model: '{"id":"mimo-v2.6-flash","providerID":"opencode-go"}',
  tokens_input: 1234,
  tokens_output: 567,
  ...overrides,
});

const text = (overrides: Partial<OpencodeSessionIndexText> = {}): OpencodeSessionIndexText => ({
  firstPrompt: "сделай фичу",
  lastMessage: "готово",
  lastMessageRole: "assistant",
  messageCount: 7,
  ...overrides,
});

function deps(overrides: Partial<OpencodeScanDeps> & {
  sessions?: OpencodeIndexRow[];
  texts?: Record<string, OpencodeSessionIndexText | null>;
  indexed?: Array<{ sessionId: string; text: string }>;
} = {}): OpencodeScanDeps {
  const indexed = overrides.indexed ?? [];
  return {
    listSessions: () => overrides.sessions ?? [row()],
    getIndexText: (id) => (overrides.texts ? overrides.texts[id] ?? null : text()),
    indexContent: (sessionId, t) => indexed.push({ sessionId, text: t }),
  };
}

describe("scanOpencodeSessions", () => {
  it("indexes a session with agent_type, model label, title and light text", async () => {
    const { db, upsert } = createSessionsDb();
    const indexed: Array<{ sessionId: string; text: string }> = [];

    const result = await scanOpencodeSessions(db, new Map(), "full", upsert, { ...deps({ indexed }) });

    expect(result).toEqual({ scanned: 1, skipped: 0 });
    const stored = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("ses_test1") as Record<string, unknown>;
    expect(stored.agent_type).toBe("opencode");
    expect(stored.jsonl_path).toBe("opencode://ses_test1");
    expect(stored.project_dir).toBe("-tmp-some-project");
    expect(stored.project_path).toBe("/tmp/some-project");
    expect(stored.model).toBe("opencode-go/mimo-v2.6-flash");
    expect(stored.generated_title).toBe("Тестовый заголовок");
    expect(stored.first_prompt).toBe("сделай фичу");
    expect(stored.last_message).toBe("готово");
    expect(stored.last_message_role).toBe("assistant");
    expect(stored.has_result).toBe(1);
    expect(stored.message_count).toBe(7);
    expect(stored.total_input_tokens).toBe(1234);
    expect(stored.total_output_tokens).toBe(567);
    expect(stored.file_mtime).toBe(1_700_000_500_000);
    expect(indexed).toEqual([
      { sessionId: "ses_test1", text: "Тестовый заголовок\nсделай фичу\nготово" },
    ]);
  });

  it("keeps a profile model label the start route stored, filling only empty ones", async () => {
    const { db, upsert } = createSessionsDb();
    db.prepare(
      `INSERT INTO sessions (session_id, jsonl_path, project_dir, project_path, model, agent_type, created_at, modified_at, file_mtime, file_size, last_scanned_at)
       VALUES ('ses_test1', 'opencode://ses_test1', '-tmp-some-project', '/tmp/some-project', 'quality', 'opencode', 'x', 'y', 1, 0, 'z')`
    ).run();

    await scanOpencodeSessions(db, new Map(), "full", upsert, deps());

    const stored = db.prepare("SELECT model FROM sessions WHERE session_id = ?").get("ses_test1") as { model: string };
    expect(stored.model).toBe("quality");
  });

  it("skips unchanged sessions on incremental scan when the FTS row exists", async () => {
    const { db, upsert } = createSessionsDb();
    db.prepare("INSERT INTO sessions_fts (session_id, content) VALUES (?, ?)").run("ses_test1", "старый текст");
    let textCalls = 0;
    const scanDeps = deps();
    const countingDeps: OpencodeScanDeps = {
      ...scanDeps,
      getIndexText: (id) => {
        textCalls++;
        return scanDeps.getIndexText!(id);
      },
    };

    const result = await scanOpencodeSessions(
      db,
      new Map([["ses_test1", 1_700_000_500_000]]),
      "incremental",
      upsert,
      countingDeps
    );

    expect(result).toEqual({ scanned: 0, skipped: 1 });
    expect(textCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 0 });
  });

  it("reindexes when the FTS row is missing or the session changed", async () => {
    const { db, upsert } = createSessionsDb();

    // No FTS row → must not skip
    const noFts = await scanOpencodeSessions(db, new Map([["ses_test1", 1_700_000_500_000]]), "incremental", upsert, deps());
    expect(noFts).toEqual({ scanned: 1, skipped: 0 });

    // FTS row exists but time_updated moved → must not skip
    db.prepare("INSERT INTO sessions_fts (session_id, content) VALUES (?, ?)").run("ses_test1", "текст");
    const changed = await scanOpencodeSessions(db, new Map([["ses_test1", 1_600_000_000_000]]), "incremental", upsert, deps());
    expect(changed).toEqual({ scanned: 1, skipped: 0 });
  });

  it("survives a session whose index text is unavailable", async () => {
    const { db, upsert } = createSessionsDb();

    const result = await scanOpencodeSessions(db, new Map(), "full", upsert, {
      ...deps({ texts: { ses_test1: null } }),
    });

    expect(result).toEqual({ scanned: 1, skipped: 0 });
    const stored = db.prepare("SELECT first_prompt, message_count, has_result FROM sessions WHERE session_id = ?").get("ses_test1") as Record<string, unknown>;
    expect(stored.first_prompt).toBeNull();
    expect(stored.message_count).toBe(0);
    expect(stored.has_result).toBe(0);
  });

  it("does nothing when OpenCode has no sessions", async () => {
    const { db, upsert } = createSessionsDb();
    const result = await scanOpencodeSessions(db, new Map(), "full", upsert, deps({ sessions: [] }));
    expect(result).toEqual({ scanned: 0, skipped: 0 });
  });
});
