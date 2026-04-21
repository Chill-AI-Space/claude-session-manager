#!/usr/bin/env python3
"""
Compact Impact Analyzer v2 — compares compression approaches on real Claude Code sessions.

JSONL structure:
- compact_boundary: {"type":"system","subtype":"compact_boundary","compactMetadata":{...}}
- Next line after compact_boundary: {"type":"user","message":{"content":"This session is being continued..."}}
- Then: normal user/assistant messages continue
"""

import json
import sys
import os
import re
from dataclasses import dataclass, field

@dataclass
class ContentBlock:
    block_type: str
    text: str
    est_tokens: int
    msg_index: int
    is_base64_image: bool = False
    is_dom_snapshot: bool = False
    tool_name: str = ""

@dataclass
class CompactEvent:
    session_file: str = ""
    compact_index: int = 0
    pre_tokens_reported: int = 0  # from compactMetadata.preTokens
    pre_compact_blocks: list = field(default_factory=list)
    pre_compact_tokens: int = 0
    pre_compact_msg_count: int = 0
    compact_summary: str = ""
    compact_summary_tokens: int = 0
    next_user_msg: str = ""
    next_user_tokens: int = 0
    next_assistant_response: str = ""
    next_assistant_needed_reread: bool = False
    next_assistant_asked_clarification: bool = False
    approach_results: dict = field(default_factory=dict)

@dataclass
class ApproachResult:
    name: str
    tokens_after: int
    tokens_saved: int
    pct_reduction: float
    info_loss_rating: str = "low"
    notes: str = ""


def est_tokens(text):
    if not text: return 0
    return len(str(text)) // 4


def is_dom_snapshot(text):
    if not text or not isinstance(text, str) or len(text) < 500:
        return False
    indicators = ["[ref=", "generic", "- link ", "- heading", "- button "]
    return sum(1 for i in indicators if i in text[:3000]) >= 3


def extract_blocks(content, msg_index):
    """Extract content blocks from a message's content field"""
    blocks = []
    if isinstance(content, str):
        blocks.append(ContentBlock("text", content, est_tokens(content), msg_index))
    elif isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            btype = item.get("type", "")

            if btype == "text":
                t = item.get("text", "")
                blocks.append(ContentBlock("text", t, est_tokens(t), msg_index,
                                           is_dom_snapshot=is_dom_snapshot(t)))
            elif btype == "thinking":
                t = item.get("thinking", "")
                blocks.append(ContentBlock("thinking", t, est_tokens(t), msg_index))
            elif btype == "tool_use":
                inp = json.dumps(item.get("input", {}), ensure_ascii=False)
                blocks.append(ContentBlock("tool_use", inp, est_tokens(inp), msg_index,
                                           tool_name=item.get("name", "")))
            elif btype == "tool_result":
                sub = item.get("content", "")
                if isinstance(sub, str):
                    blocks.append(ContentBlock("tool_result", sub, est_tokens(sub), msg_index,
                                               is_dom_snapshot=is_dom_snapshot(sub)))
                elif isinstance(sub, list):
                    for s in sub:
                        if not isinstance(s, dict): continue
                        if s.get("type") == "image" or (s.get("source", {}).get("type") == "base64"):
                            data = s.get("source", {}).get("data", s.get("data", ""))
                            blocks.append(ContentBlock("tool_result", str(data)[:100], est_tokens(data), msg_index,
                                                       is_base64_image=True))
                        elif s.get("type") == "text":
                            t = s.get("text", "")
                            blocks.append(ContentBlock("tool_result", t, est_tokens(t), msg_index,
                                                       is_dom_snapshot=is_dom_snapshot(t)))
            elif btype == "image" or (item.get("source", {}).get("type") == "base64"):
                data = item.get("source", {}).get("data", "")
                blocks.append(ContentBlock("image", str(data)[:100], est_tokens(data), msg_index,
                                           is_base64_image=True))
    return blocks


def parse_session(jsonl_path):
    """Parse JSONL into raw message list, detecting compact boundaries"""
    entries = []
    with open(jsonl_path, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            entries.append(obj)
    return entries


def find_compact_events(entries, session_path):
    """Find compact_boundary events and build analysis windows"""
    events = []
    compact_boundary_indices = []

    for i, obj in enumerate(entries):
        if obj.get("type") == "system" and obj.get("subtype") == "compact_boundary":
            compact_boundary_indices.append(i)

    for ci, cb_idx in enumerate(compact_boundary_indices):
        cb_obj = entries[cb_idx]
        pre_tokens = cb_obj.get("compactMetadata", {}).get("preTokens", 0)

        # Find the summary user message (next entry after compact_boundary)
        summary_msg = None
        summary_idx = cb_idx + 1
        while summary_idx < len(entries):
            e = entries[summary_idx]
            if e.get("type") == "user":
                content = e.get("message", {}).get("content", e.get("content", ""))
                if isinstance(content, str) and "continued from a previous" in content:
                    summary_msg = content
                    break
                elif isinstance(content, str) and len(content) > 500:
                    summary_msg = content
                    break
            summary_idx += 1
            if summary_idx > cb_idx + 5:
                break

        # Find pre-compact window: messages between previous compact and this one
        if ci > 0:
            window_start = compact_boundary_indices[ci - 1] + 1
            # Skip the previous summary message
            while window_start < cb_idx:
                e = entries[window_start]
                if e.get("type") in ("user", "assistant"):
                    content = e.get("message", {}).get("content", e.get("content", ""))
                    if isinstance(content, str) and "continued from a previous" in content:
                        window_start += 1
                        continue
                break
        else:
            window_start = 0

        # Extract pre-compact messages
        pre_msgs = []
        msg_idx = 0
        for i in range(window_start, cb_idx):
            e = entries[i]
            if e.get("type") not in ("user", "assistant"):
                continue
            content = e.get("message", {}).get("content", e.get("content", ""))
            pre_msgs.append({"type": e["type"], "content": content, "index": msg_idx})
            msg_idx += 1

        # Build content blocks
        all_blocks = []
        for msg in pre_msgs:
            blocks = extract_blocks(msg["content"], msg["index"])
            all_blocks.extend(blocks)

        total_pre_tokens = sum(b.est_tokens for b in all_blocks)

        # Find next REAL user message (after summary) — may be 50-200 entries later
        next_user_text = ""
        next_user_idx = summary_idx + 1 if summary_msg else cb_idx + 1
        # Also find next compact boundary to stop searching
        next_compact_idx = compact_boundary_indices[ci + 1] if ci + 1 < len(compact_boundary_indices) else len(entries)
        while next_user_idx < min(len(entries), next_compact_idx):
            e = entries[next_user_idx]
            if e.get("type") == "user":
                content = e.get("message", {}).get("content", e.get("content", ""))
                # Extract text, skip summaries
                candidate = ""
                if isinstance(content, str):
                    if "continued from a previous" not in content and len(content.strip()) > 5:
                        candidate = content[:500]
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            t = item.get("text", "")
                            if "continued from a previous" not in t:
                                candidate += t
                    candidate = candidate[:500]
                if candidate.strip():
                    next_user_text = candidate
                    break
            next_user_idx += 1

        # Find next assistant response
        needed_reread = False
        asked_clarification = False
        next_asst_text = ""
        asst_idx = next_user_idx + 1
        while asst_idx < len(entries):
            e = entries[asst_idx]
            if e.get("type") == "assistant":
                content = e.get("message", {}).get("content", e.get("content", ""))
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict):
                            if item.get("type") == "text":
                                next_asst_text += item.get("text", "")
                            elif item.get("type") == "tool_use":
                                tn = item.get("name", "")
                                if tn in ("Read", "Grep", "Glob", "Bash", "Agent"):
                                    needed_reread = True
                elif isinstance(content, str):
                    next_asst_text = content
                break
            asst_idx += 1
            if asst_idx > next_user_idx + 10:
                break

        clarify_patterns = ["could you clarify", "can you specify", "what do you mean",
                           "не могли бы", "что именно", "уточните", "какой файл", "I'm not sure what"]
        for p in clarify_patterns:
            if p.lower() in next_asst_text.lower()[:500]:
                asked_clarification = True
                break

        event = CompactEvent(
            session_file=session_path,
            compact_index=ci,
            pre_tokens_reported=pre_tokens,
            pre_compact_blocks=all_blocks,
            pre_compact_tokens=total_pre_tokens,
            pre_compact_msg_count=len(pre_msgs),
            compact_summary=summary_msg or "",
            compact_summary_tokens=est_tokens(summary_msg or ""),
            next_user_msg=next_user_text,
            next_user_tokens=est_tokens(next_user_text),
            next_assistant_response=next_asst_text[:300],
            next_assistant_needed_reread=needed_reread,
            next_assistant_asked_clarification=asked_clarification,
        )
        events.append(event)

    return events


def simulate_approaches(event):
    blocks = event.pre_compact_blocks
    total = event.pre_compact_tokens
    msg_count = event.pre_compact_msg_count
    recent_thr = max(0, msg_count - 3)

    results = {}

    # A) Full Compact
    results["full_compact"] = ApproachResult(
        "Full Compact (Claude built-in)",
        event.compact_summary_tokens,
        total - event.compact_summary_tokens,
        round((1 - event.compact_summary_tokens / max(total, 1)) * 100, 1),
        "high",
        f"Summary: {event.compact_summary_tokens:,} tok. All original messages gone."
    )

    # B) Observation Masking
    masked = sum(10 if (b.block_type == "tool_result" and b.msg_index < recent_thr) else b.est_tokens for b in blocks)
    results["obs_masking"] = ApproachResult(
        "Observation Masking (JetBrains)",
        masked, total - masked,
        round((1 - masked / max(total, 1)) * 100, 1),
        "medium",
        "Old tool_results → '[masked]'. Recent 3 msgs fully preserved."
    )

    # C) Element-Level OCR+Regex
    elem = 0
    ss_count = dom_count = big_text_count = 0
    for b in blocks:
        if b.is_base64_image:
            elem += 500; ss_count += 1
        elif b.is_dom_snapshot and b.msg_index < recent_thr:
            elem += b.est_tokens // 7; dom_count += 1
        elif b.block_type == "tool_result" and b.est_tokens > 5000 and b.msg_index < recent_thr:
            elem += b.est_tokens // 10; big_text_count += 1
        else:
            elem += b.est_tokens
    results["element_level"] = ApproachResult(
        "Element-Level (OCR+Regex+AI)",
        elem, total - elem,
        round((1 - elem / max(total, 1)) * 100, 1),
        "low",
        f"OCR'd {ss_count} screenshots, cleaned {dom_count} DOM, summarized {big_text_count} large text. Structure preserved."
    )

    # D) Aggressive Masking
    aggr = sum(5 if (b.block_type == "tool_result" and (b.msg_index < recent_thr or b.is_base64_image)) else b.est_tokens for b in blocks)
    results["aggressive_mask"] = ApproachResult(
        "Aggressive Masking",
        aggr, total - aggr,
        round((1 - aggr / max(total, 1)) * 100, 1),
        "high",
        "All old tool outputs + all screenshots removed."
    )

    # E) No compression
    results["no_compression"] = ApproachResult(
        "No Compression",
        total, 0, 0, "none",
        f"Full: {total:,} tok. Would need {total // 1000}k of 200k window."
    )

    # F) Microcompaction only
    micro = 0
    for b in blocks:
        if b.block_type == "tool_result" and b.msg_index < recent_thr:
            if b.is_base64_image:
                micro += b.est_tokens  # NOT handled
            elif b.est_tokens > 1000:
                micro += 50  # path reference
            else:
                micro += b.est_tokens
        else:
            micro += b.est_tokens
    results["microcompaction"] = ApproachResult(
        "Microcompaction Only",
        micro, total - micro,
        round((1 - micro / max(total, 1)) * 100, 1),
        "medium",
        "Old text → path refs. Screenshots UNTOUCHED (major gap)."
    )

    return results


def analyze_question_refs(event):
    q = event.next_user_msg.lower()
    blocks = event.pre_compact_blocks
    return {
        "mentions_file": any(p in q for p in [".ts", ".tsx", ".js", ".py", ".css", ".html", "file", "файл"]),
        "mentions_screenshot": any(p in q for p in ["screenshot", "скриншот", "картинк", "image", "экран"]),
        "mentions_error": any(p in q for p in ["error", "ошибк", "bug", "баг", "не работает", "failed"]),
        "mentions_previous": any(p in q for p in ["earlier", "before", "ранее", "раньше", "прошл", "до этого", "уже"]),
        "is_continuation": any(p in q for p in ["continue", "продолж", "дальше", "давай", "теперь"]),
        "screenshots_in_context": sum(1 for b in blocks if b.is_base64_image),
        "screenshot_tokens": sum(b.est_tokens for b in blocks if b.is_base64_image),
        "dom_in_context": sum(1 for b in blocks if b.is_dom_snapshot),
        "dom_tokens": sum(b.est_tokens for b in blocks if b.is_dom_snapshot),
        "large_tool_results": sum(1 for b in blocks if b.block_type == "tool_result" and b.est_tokens > 5000),
        "total_elements": len(blocks),
    }


def main():
    base = os.path.expanduser("~/.claude/projects")
    jsonl_files = []
    for root, dirs, files in os.walk(base):
        if "subagents" in root: continue
        for f in files:
            if f.endswith(".jsonl"):
                full = os.path.join(root, f)
                if os.path.getsize(full) > 5_000_000:
                    jsonl_files.append((full, os.path.getsize(full)))

    jsonl_files.sort(key=lambda x: -x[1])
    jsonl_files = jsonl_files[:20]

    print(f"Analyzing {len(jsonl_files)} sessions...")
    all_events = []

    for fpath, fsize in jsonl_files:
        fname = os.path.basename(fpath)
        # Get project name from path
        proj = fpath.split("/projects/")[1].split("/")[0] if "/projects/" in fpath else "unknown"
        print(f"  {fname[:12]}... ({fsize//1_000_000}MB, {proj[:30]})...", end=" ", flush=True)
        try:
            entries = parse_session(fpath)
            events = find_compact_events(entries, fpath)
            for e in events:
                e.approach_results = simulate_approaches(e)
            all_events.extend(events)
            print(f"{len(events)} compacts, {len(entries)} entries")
        except Exception as ex:
            print(f"ERROR: {ex}")

    print(f"\nTotal compact events: {len(all_events)}")

    # Build report
    report = {"total_compacts": len(all_events), "events": []}

    for event in all_events:
        refs = analyze_question_refs(event)
        e = {
            "session": os.path.basename(event.session_file)[:12],
            "compact_idx": event.compact_index,
            "pre_tokens_reported": event.pre_tokens_reported,
            "pre_tokens_estimated": event.pre_compact_tokens,
            "pre_msg_count": event.pre_compact_msg_count,
            "compact_summary_tokens": event.compact_summary_tokens,
            "next_question": event.next_user_msg[:300],
            "next_question_refs": refs,
            "post_compact": {
                "needed_reread": event.next_assistant_needed_reread,
                "asked_clarification": event.next_assistant_asked_clarification,
                "response_preview": event.next_assistant_response[:200],
            },
            "approaches": {k: {"name": v.name, "tokens_after": v.tokens_after,
                               "pct_reduction": v.pct_reduction, "info_loss": v.info_loss_rating,
                               "notes": v.notes}
                          for k, v in event.approach_results.items()}
        }
        report["events"].append(e)

    # Aggregates
    approach_keys = ["full_compact", "obs_masking", "element_level", "aggressive_mask", "microcompaction", "no_compression"]
    agg = {}
    for key in approach_keys:
        vals = [e["approaches"][key]["pct_reduction"] for e in report["events"] if key in e["approaches"]]
        if vals:
            agg[key] = {
                "name": report["events"][0]["approaches"][key]["name"],
                "avg_pct": round(sum(vals)/len(vals), 1),
                "min_pct": round(min(vals), 1),
                "max_pct": round(max(vals), 1),
                "count": len(vals),
            }
    report["aggregate"] = agg

    # Post-compact stats
    total = len(all_events)
    rr = sum(1 for e in all_events if e.next_assistant_needed_reread)
    cl = sum(1 for e in all_events if e.next_assistant_asked_clarification)
    report["post_compact_stats"] = {
        "total": total,
        "needed_reread": rr, "reread_pct": round(rr/max(total,1)*100,1),
        "asked_clarification": cl, "clarification_pct": round(cl/max(total,1)*100,1),
    }

    # Context composition across all events
    total_ss = sum(r["next_question_refs"]["screenshots_in_context"] for r in report["events"])
    total_ss_tok = sum(r["next_question_refs"]["screenshot_tokens"] for r in report["events"])
    total_dom = sum(r["next_question_refs"]["dom_in_context"] for r in report["events"])
    total_big = sum(r["next_question_refs"]["large_tool_results"] for r in report["events"])
    report["context_composition"] = {
        "total_screenshots": total_ss,
        "total_screenshot_tokens": total_ss_tok,
        "avg_screenshots_per_compact": round(total_ss/max(total,1), 1),
        "total_dom_snapshots": total_dom,
        "total_large_tool_results": total_big,
    }

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "compact_impact_data.json")
    with open(out, 'w') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nSaved to {out}")

    # Console summary
    print("\n" + "="*70)
    print("AGGREGATE COMPARISON ACROSS ALL COMPACT EVENTS")
    print("="*70)
    for key in approach_keys:
        if key in agg:
            a = agg[key]
            print(f"\n  {a['name']}:")
            print(f"    Avg reduction: {a['avg_pct']}%  (range: {a['min_pct']}% — {a['max_pct']}%)")

    pcs = report["post_compact_stats"]
    print(f"\n  Post-compact behavior:")
    print(f"    Claude re-read files: {pcs['reread_pct']}% of compacts ({pcs['needed_reread']}/{pcs['total']})")
    print(f"    Asked clarification:  {pcs['clarification_pct']}% ({pcs['asked_clarification']}/{pcs['total']})")

    cc = report["context_composition"]
    print(f"\n  Context composition at compact time:")
    print(f"    Avg screenshots per compact: {cc['avg_screenshots_per_compact']}")
    print(f"    Total screenshot tokens: {cc['total_screenshot_tokens']:,}")
    print(f"    Total DOM snapshots: {cc['total_dom_snapshots']}")
    print(f"    Total large tool_results (>5k): {cc['total_large_tool_results']}")

    # Print examples
    print("\n" + "="*70)
    print(f"EXAMPLES (first {min(8, len(all_events))})")
    print("="*70)
    for event in all_events[:8]:
        refs = analyze_question_refs(event)
        print(f"\n--- Compact #{event.compact_index} ({os.path.basename(event.session_file)[:12]}) ---")
        print(f"  Pre-compact: {event.pre_compact_tokens:,} tok (reported: {event.pre_tokens_reported:,}), {event.pre_compact_msg_count} msgs")
        print(f"  Screenshots: {refs['screenshots_in_context']}, DOM: {refs['dom_in_context']}, Large: {refs['large_tool_results']}")
        print(f"  Summary: {event.compact_summary_tokens:,} tok")
        q = event.next_user_msg[:120].replace('\n', ' ')
        print(f"  Next Q: \"{q}\"")
        print(f"  Claude re-read: {event.next_assistant_needed_reread}, Clarification: {event.next_assistant_asked_clarification}")
        for key in approach_keys:
            r = event.approach_results[key]
            print(f"    {r.name:35s}: {r.tokens_after:>8,} tok ({r.pct_reduction:>5.1f}% saved, loss={r.info_loss_rating})")


if __name__ == "__main__":
    main()
