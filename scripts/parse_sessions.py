#!/usr/bin/env python3
"""
Parse all Claude Code JSONL sessions from ~/.claude/projects/ into SQLite analytics DB.

Tables:
  sessions        — one row per session (metadata, totals)
  messages        — every user/assistant/system message
  tool_calls      — every tool_use invocation
  compacts        — compact_boundary events with pre/post context size
  context_timeline — token accumulation over time
  mcp_tools       — MCP tool usage aggregated per session
"""

import json
import os
import sys
import sqlite3
import time
from pathlib import Path
from collections import defaultdict
from datetime import datetime

PROJECTS_DIR = Path.home() / ".claude" / "projects"
DB_PATH = Path(__file__).parent.parent / "data" / "analytics.db"


def create_schema(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            jsonl_path TEXT NOT NULL,
            file_size INTEGER,
            project_dir TEXT,
            project_path TEXT,
            cwd TEXT,
            git_branch TEXT,
            slug TEXT,
            claude_version TEXT,
            model TEXT,
            first_prompt TEXT,
            first_prompt_length INTEGER,
            message_count INTEGER DEFAULT 0,
            user_message_count INTEGER DEFAULT 0,
            assistant_message_count INTEGER DEFAULT 0,
            tool_call_count INTEGER DEFAULT 0,
            compact_count INTEGER DEFAULT 0,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cache_read_tokens INTEGER DEFAULT 0,
            total_cache_creation_tokens INTEGER DEFAULT 0,
            total_thinking_tokens INTEGER DEFAULT 0,
            is_subagent INTEGER DEFAULT 0,
            parent_session_id TEXT,
            started_at TEXT,
            ended_at TEXT,
            duration_seconds REAL,
            parsed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            uuid TEXT,
            parent_uuid TEXT,
            type TEXT NOT NULL,
            subtype TEXT,
            role TEXT,
            model TEXT,
            timestamp TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_creation_tokens INTEGER,
            thinking_tokens INTEGER,
            stop_reason TEXT,
            content_length INTEGER,
            has_thinking INTEGER DEFAULT 0,
            has_tool_use INTEGER DEFAULT 0,
            is_sidechain INTEGER DEFAULT 0,
            line_number INTEGER
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            message_uuid TEXT,
            tool_name TEXT NOT NULL,
            tool_use_id TEXT,
            input_json TEXT,
            is_mcp INTEGER DEFAULT 0,
            mcp_server TEXT,
            timestamp TEXT,
            line_number INTEGER
        );

        CREATE TABLE IF NOT EXISTS compacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            timestamp TEXT,
            line_number INTEGER,
            pre_input_tokens INTEGER,
            post_input_tokens INTEGER,
            summary_length INTEGER,
            messages_before INTEGER,
            messages_after INTEGER
        );

        CREATE TABLE IF NOT EXISTS context_timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            timestamp TEXT,
            cumulative_input_tokens INTEGER,
            cumulative_output_tokens INTEGER,
            cumulative_cache_read INTEGER,
            message_index INTEGER
        );

        CREATE TABLE IF NOT EXISTS parse_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            files_processed INTEGER DEFAULT 0,
            files_skipped INTEGER DEFAULT 0,
            errors INTEGER DEFAULT 0,
            duration_seconds REAL
        );

        CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_msg_type ON messages(type);
        CREATE INDEX IF NOT EXISTS idx_tc_session ON tool_calls(session_id);
        CREATE INDEX IF NOT EXISTS idx_tc_name ON tool_calls(tool_name);
        CREATE INDEX IF NOT EXISTS idx_compacts_session ON compacts(session_id);
        CREATE INDEX IF NOT EXISTS idx_ctx_session ON context_timeline(session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
    """)
    conn.commit()


def extract_text_content(content) -> str:
    """Extract plain text from message content (string or list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return ""


def parse_session(jsonl_path: Path, conn: sqlite3.Connection, is_subagent: bool = False):
    """Parse a single JSONL file into the analytics DB."""
    session_id = jsonl_path.stem
    file_size = jsonl_path.stat().st_size

    # Determine project dir from path
    rel = str(jsonl_path.relative_to(PROJECTS_DIR))
    parts = rel.split("/")
    project_dir = parts[0] if parts else ""

    # Session-level accumulators
    meta = {
        "cwd": None, "git_branch": None, "slug": None,
        "claude_version": None, "model": None,
        "first_prompt": None, "first_prompt_length": 0,
    }
    counts = defaultdict(int)
    tokens = defaultdict(int)
    timestamps = []
    parent_session_id = None

    messages_batch = []
    tools_batch = []
    compacts_batch = []
    timeline_batch = []

    cum_input = 0
    cum_output = 0
    cum_cache_read = 0
    msg_idx = 0
    last_input_tokens = 0  # track for compact pre-size

    with open(jsonl_path, "r", errors="replace") as f:
        for line_num, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = obj.get("type", "")

            # Extract metadata from first messages
            if meta["cwd"] is None and obj.get("cwd"):
                meta["cwd"] = obj["cwd"]
            if meta["git_branch"] is None and obj.get("gitBranch"):
                meta["git_branch"] = obj["gitBranch"]
            if meta["slug"] is None and obj.get("slug"):
                meta["slug"] = obj["slug"]
            if meta["claude_version"] is None and obj.get("version"):
                meta["claude_version"] = obj["version"]

            ts = obj.get("timestamp")
            if ts:
                timestamps.append(ts)

            # Detect parent session for subagents
            if obj.get("sessionId") and obj["sessionId"] != session_id:
                parent_session_id = obj["sessionId"]

            # ── USER messages ──
            if msg_type == "user":
                counts["user"] += 1
                counts["total"] += 1
                content = obj.get("message", {}).get("content", "")
                text = extract_text_content(content)

                if meta["first_prompt"] is None and text and not text.startswith("[Request interrupted"):
                    meta["first_prompt"] = text[:2000]
                    meta["first_prompt_length"] = len(text)

                # Check for tool_result blocks
                has_tool_result = False
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            has_tool_result = True
                            break

                messages_batch.append((
                    session_id, obj.get("uuid"), obj.get("parentUuid"),
                    "user", None, "user", None, ts,
                    None, None, None, None, None, None,
                    len(text), 0, int(has_tool_result),
                    int(obj.get("isSidechain", False)), line_num
                ))

            # ── ASSISTANT messages ──
            elif msg_type == "assistant":
                counts["assistant"] += 1
                counts["total"] += 1
                msg = obj.get("message", {})
                usage = msg.get("usage", {})
                model = msg.get("model")
                if model and not meta["model"]:
                    meta["model"] = model

                input_t = usage.get("input_tokens", 0)
                output_t = usage.get("output_tokens", 0)
                cache_read = usage.get("cache_read_input_tokens", 0)
                cache_create = usage.get("cache_creation_input_tokens", 0)

                # Thinking tokens (from server_tool_use or thinking blocks)
                thinking_t = 0
                content = msg.get("content", [])
                has_thinking = False
                has_tool_use = False
                content_len = 0

                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict):
                            if block.get("type") == "thinking":
                                has_thinking = True
                                thinking_t += len(block.get("thinking", ""))
                            elif block.get("type") == "text":
                                content_len += len(block.get("text", ""))
                            elif block.get("type") == "tool_use":
                                has_tool_use = True
                                tool_name = block.get("name", "unknown")
                                tool_id = block.get("id", "")
                                is_mcp = tool_name.startswith("mcp__")
                                mcp_server = tool_name.split("__")[1] if is_mcp and "__" in tool_name[4:] else None

                                # Store input as JSON, truncate large inputs
                                tool_input = block.get("input", {})
                                try:
                                    input_json = json.dumps(tool_input)
                                    if len(input_json) > 5000:
                                        input_json = input_json[:5000] + "..."
                                except:
                                    input_json = None

                                tools_batch.append((
                                    session_id, obj.get("uuid"), tool_name, tool_id,
                                    input_json, int(is_mcp), mcp_server, ts, line_num
                                ))
                                counts["tool_calls"] += 1

                tokens["input"] += input_t
                tokens["output"] += output_t
                tokens["cache_read"] += cache_read
                tokens["cache_create"] += cache_create
                tokens["thinking"] += thinking_t

                cum_input += input_t
                cum_output += output_t
                cum_cache_read += cache_read
                last_input_tokens = input_t

                messages_batch.append((
                    session_id, obj.get("uuid"), obj.get("parentUuid"),
                    "assistant", None, "assistant", model, ts,
                    input_t, output_t, cache_read, cache_create, thinking_t,
                    msg.get("stop_reason"), content_len,
                    int(has_thinking), int(has_tool_use),
                    int(obj.get("isSidechain", False)), line_num
                ))

                msg_idx += 1
                if ts:
                    timeline_batch.append((
                        session_id, ts, cum_input, cum_output, cum_cache_read, msg_idx
                    ))

            # ── SYSTEM messages (compact boundaries) ──
            elif msg_type == "system":
                subtype = obj.get("subtype", "")
                counts["total"] += 1

                messages_batch.append((
                    session_id, None, obj.get("parentUuid"),
                    "system", subtype, None, None, ts,
                    None, None, None, None, None,
                    obj.get("stopReason"), 0, 0, 0, 0, line_num
                ))

                if subtype == "compact_boundary":
                    counts["compacts"] += 1
                    compacts_batch.append((
                        session_id, ts, line_num,
                        last_input_tokens, None, None,
                        msg_idx, None
                    ))

            # ── PROGRESS ──
            elif msg_type == "progress":
                pass  # Skip progress for now — too noisy

    # Calculate timing
    started_at = timestamps[0] if timestamps else None
    ended_at = timestamps[-1] if timestamps else None
    duration = None
    if started_at and ended_at:
        try:
            t0 = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
            duration = (t1 - t0).total_seconds()
        except:
            pass

    # Convert project_dir to project_path
    project_path = project_dir.replace("-", "/") if project_dir else ""

    # Insert session
    conn.execute("""
        INSERT OR REPLACE INTO sessions VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    """, (
        session_id, str(jsonl_path), file_size, project_dir, project_path,
        meta["cwd"], meta["git_branch"], meta["slug"], meta["claude_version"],
        meta["model"], meta["first_prompt"], meta["first_prompt_length"],
        counts["total"], counts["user"], counts["assistant"],
        counts["tool_calls"], counts["compacts"],
        tokens["input"], tokens["output"], tokens["cache_read"],
        tokens["cache_create"], tokens["thinking"],
        int(is_subagent), parent_session_id,
        started_at, ended_at, duration,
        datetime.utcnow().isoformat()
    ))

    # Batch insert messages
    conn.executemany("""
        INSERT INTO messages (
            session_id, uuid, parent_uuid, type, subtype, role, model, timestamp,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            thinking_tokens, stop_reason, content_length, has_thinking, has_tool_use,
            is_sidechain, line_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, messages_batch)

    # Batch insert tool calls
    conn.executemany("""
        INSERT INTO tool_calls (
            session_id, message_uuid, tool_name, tool_use_id, input_json,
            is_mcp, mcp_server, timestamp, line_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, tools_batch)

    # Batch insert compacts
    conn.executemany("""
        INSERT INTO compacts (
            session_id, timestamp, line_number,
            pre_input_tokens, post_input_tokens, summary_length,
            messages_before, messages_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, compacts_batch)

    # Batch insert timeline
    conn.executemany("""
        INSERT INTO context_timeline (
            session_id, timestamp, cumulative_input_tokens,
            cumulative_output_tokens, cumulative_cache_read, message_index
        ) VALUES (?, ?, ?, ?, ?, ?)
    """, timeline_batch)

    return counts["total"]


def find_all_jsonl():
    """Find all JSONL files, separating main sessions from subagents."""
    main_sessions = []
    subagent_sessions = []

    for root, dirs, files in os.walk(PROJECTS_DIR):
        for f in files:
            if f.endswith(".jsonl"):
                p = Path(root) / f
                if "/subagents/" in str(p):
                    subagent_sessions.append(p)
                else:
                    main_sessions.append(p)

    return main_sessions, subagent_sessions


def main():
    print(f"Analytics DB: {DB_PATH}")
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    create_schema(conn)

    # Check for incremental mode
    incremental = "--full" not in sys.argv
    existing = set()
    if incremental:
        rows = conn.execute("SELECT session_id, parsed_at FROM sessions").fetchall()
        existing = {r[0] for r in rows}
        if existing:
            print(f"Incremental mode: {len(existing)} sessions already parsed")

    main_sessions, subagent_sessions = find_all_jsonl()
    all_files = [(p, False) for p in main_sessions] + [(p, True) for p in subagent_sessions]
    print(f"Found {len(main_sessions)} main + {len(subagent_sessions)} subagent sessions")

    run_start = datetime.utcnow().isoformat()
    processed = 0
    skipped = 0
    errors = 0
    total = len(all_files)

    for i, (path, is_sub) in enumerate(all_files):
        sid = path.stem
        if incremental and sid in existing:
            # Check if file was modified since last parse
            try:
                mtime = datetime.utcfromtimestamp(path.stat().st_mtime).isoformat()
                row = conn.execute(
                    "SELECT parsed_at FROM sessions WHERE session_id = ?", (sid,)
                ).fetchone()
                if row and row[0] >= mtime:
                    skipped += 1
                    continue
            except:
                pass

        try:
            # Clear old data for this session
            for table in ["messages", "tool_calls", "compacts", "context_timeline"]:
                conn.execute(f"DELETE FROM {table} WHERE session_id = ?", (sid,))

            msg_count = parse_session(path, conn, is_sub)
            processed += 1

            if processed % 50 == 0:
                conn.commit()
                pct = (i + 1) / total * 100
                print(f"  [{pct:5.1f}%] {processed} parsed, {skipped} skipped, {errors} errors")

        except Exception as e:
            errors += 1
            if errors <= 10:
                print(f"  ERROR {path.name}: {e}")

    conn.commit()

    # Record parse run
    run_end = datetime.utcnow().isoformat()
    duration = time.time() - time.mktime(datetime.fromisoformat(run_start).timetuple())
    conn.execute("""
        INSERT INTO parse_runs (started_at, finished_at, files_processed, files_skipped, errors, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (run_start, run_end, processed, skipped, errors, duration))
    conn.commit()

    # Print summary
    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_msgs = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    total_tools = conn.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0]
    total_compacts = conn.execute("SELECT COUNT(*) FROM compacts").fetchone()[0]

    print(f"\n{'='*60}")
    print(f"Done! Processed {processed}, skipped {skipped}, errors {errors}")
    print(f"DB totals: {total_sessions} sessions, {total_msgs} messages, {total_tools} tool calls, {total_compacts} compacts")
    print(f"DB size: {DB_PATH.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"Duration: {duration:.1f}s")

    conn.close()


if __name__ == "__main__":
    main()
