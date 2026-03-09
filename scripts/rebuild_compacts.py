#!/usr/bin/env python3
"""Rebuild compacts table with correct context size from cache_read + cache_create + input."""
import sqlite3, json, os
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "analytics.db"
conn = sqlite3.connect(str(DB_PATH))

compact_sessions = conn.execute(
    "SELECT DISTINCT c.session_id, s.jsonl_path FROM compacts c JOIN sessions s ON s.session_id = c.session_id"
).fetchall()
print(f"Reprocessing {len(compact_sessions)} sessions with compacts...")

conn.execute("DELETE FROM compacts")
total_compacts = 0

for sid, jpath in compact_sessions:
    if not os.path.exists(jpath):
        continue

    lines_data = []
    with open(jpath, errors="replace") as f:
        for i, line in enumerate(f):
            try:
                obj = json.loads(line.strip())
                lines_data.append((i, obj))
            except Exception:
                continue

    for idx, (ln, obj) in enumerate(lines_data):
        if obj.get("type") != "system" or obj.get("subtype") != "compact_boundary":
            continue

        ts = obj.get("timestamp")

        # Find last assistant with cache data BEFORE compact
        pre_context = 0
        for j in range(idx - 1, max(idx - 15, 0), -1):
            prev_ln, prev = lines_data[j]
            if prev.get("type") == "assistant":
                usage = prev.get("message", {}).get("usage", {})
                cr = usage.get("cache_read_input_tokens", 0)
                cc = usage.get("cache_creation_input_tokens", 0)
                inp = usage.get("input_tokens", 0)
                total = cr + cc + inp
                if total > pre_context:
                    pre_context = total
                break

        # Find first assistant with cache data AFTER compact
        post_context = 0
        summary_length = 0
        for j in range(idx + 1, min(idx + 15, len(lines_data))):
            next_ln, nxt = lines_data[j]
            if nxt.get("type") == "user" and summary_length == 0:
                content = nxt.get("message", {}).get("content", "")
                if isinstance(content, str):
                    summary_length = len(content)
                elif isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "text":
                            summary_length += len(b.get("text", ""))
            if nxt.get("type") == "assistant":
                usage = nxt.get("message", {}).get("usage", {})
                cr = usage.get("cache_read_input_tokens", 0)
                cc = usage.get("cache_creation_input_tokens", 0)
                inp = usage.get("input_tokens", 0)
                total = cr + cc + inp
                if total > 100:
                    post_context = total
                    break

        msgs_before = sum(1 for _, o in lines_data[:idx] if o.get("type") in ("user", "assistant"))

        conn.execute(
            "INSERT INTO compacts (session_id, timestamp, line_number, pre_input_tokens, post_input_tokens, summary_length, messages_before, messages_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, ts, ln, pre_context, post_context, summary_length, msgs_before, None),
        )
        total_compacts += 1

conn.commit()
print(f"Rebuilt {total_compacts} compacts")

# Analysis
print("\n=== COMPACT CONTEXT REDUCTION (pre>1K & post>1K) ===")
for r in conn.execute("""
    SELECT c.session_id, c.timestamp, c.pre_input_tokens, c.post_input_tokens,
           c.summary_length, c.messages_before, s.project_dir, s.model
    FROM compacts c JOIN sessions s ON s.session_id = c.session_id
    WHERE c.pre_input_tokens > 1000 AND c.post_input_tokens > 1000
    ORDER BY c.timestamp DESC LIMIT 25
"""):
    sid, ts, pre, post, slen, msgs, proj, model = r
    reduction = (pre - post) / pre * 100
    proj_short = proj.split("GitHub-")[-1] if "GitHub-" in proj else proj
    print(f"  {ts[:16]} | {proj_short:25s} | {pre:7,d} -> {post:7,d} ({reduction:+5.1f}%) | summary:{slen:6,d}ch | msgs:{msgs:4d}")

print("\n=== OVERALL COMPACT STATISTICS ===")
valid = conn.execute("""
    SELECT COUNT(*), AVG(pre_input_tokens), AVG(post_input_tokens),
           AVG(summary_length), AVG(messages_before),
           AVG(CASE WHEN pre_input_tokens > 0 THEN (pre_input_tokens - post_input_tokens) * 100.0 / pre_input_tokens END)
    FROM compacts WHERE pre_input_tokens > 1000 AND post_input_tokens > 1000
""").fetchone()
print(f"  Valid compacts: {valid[0]}")
print(f"  Avg pre-context:  {valid[1]:,.0f} tokens")
print(f"  Avg post-context: {valid[2]:,.0f} tokens")
print(f"  Avg reduction:    {valid[5]:.1f}%")
print(f"  Avg summary size: {valid[3]:,.0f} chars")
print(f"  Avg msgs before:  {valid[4]:.0f}")

# All compacts including those where post=0 (session ended after compact)
all_stats = conn.execute("""
    SELECT COUNT(*), AVG(pre_input_tokens), AVG(summary_length), AVG(messages_before)
    FROM compacts WHERE pre_input_tokens > 1000
""").fetchone()
print(f"\n=== ALL COMPACTS (pre>1K, any post) ===")
print(f"  Total: {all_stats[0]}")
print(f"  Avg pre-context:  {all_stats[1]:,.0f} tokens")
print(f"  Avg summary size: {all_stats[2]:,.0f} chars")
print(f"  Avg msgs before:  {all_stats[3]:.0f}")

conn.close()
