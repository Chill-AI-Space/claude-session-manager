import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

interface LogEntry {
  keyword_rank: number | null;
  gemini_rank: number | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500);

  const db = getDb();
  const entries = db.prepare(
    `SELECT * FROM autodetect_log ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as LogEntry[];

  const total = entries.length;
  const keywordHits = entries.filter(e => e.keyword_rank !== null && e.keyword_rank <= 5).length;
  const keywordTop1 = entries.filter(e => e.keyword_rank === 1).length;
  const geminiHits = entries.filter(e => e.gemini_rank !== null && e.gemini_rank <= 5).length;
  const geminiTop1 = entries.filter(e => e.gemini_rank === 1).length;
  const misses = entries.filter(e => e.keyword_rank === null && e.gemini_rank === null).length;

  return NextResponse.json({
    entries,
    stats: {
      total,
      keyword_hit_rate: total > 0 ? Math.round((keywordHits / total) * 100) : 0,
      keyword_top1_rate: total > 0 ? Math.round((keywordTop1 / total) * 100) : 0,
      gemini_hit_rate: total > 0 ? Math.round((geminiHits / total) * 100) : 0,
      gemini_top1_rate: total > 0 ? Math.round((geminiTop1 / total) * 100) : 0,
      total_misses: misses,
    },
  });
}

export async function DELETE() {
  const db = getDb();
  db.prepare("DELETE FROM autodetect_log").run();
  return NextResponse.json({ ok: true });
}
