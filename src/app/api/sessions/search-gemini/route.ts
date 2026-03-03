import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { SessionRow } from "@/lib/types";
import { vectorSearch, generateMissingEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const query = body.query;

  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      error: "GEMINI_API_KEY not configured. Add it to .env.local",
      results: [],
    });
  }

  const db = getDb();

  try {
    // Step 0: Auto-generate embeddings for sessions that don't have them yet (best-effort)
    await generateMissingEmbeddings().catch(() => {});

    // Step 1: Vector pre-filter — fast cosine similarity to narrow down candidates
    let vectorResults: { session_id: string; score: number }[] = [];
    try {
      vectorResults = await vectorSearch(query);
    } catch {
      // Vector search failed (e.g. rate limit on query embedding) — fallback to recent
    }

    let sessions: Pick<
      SessionRow,
      "session_id" | "project_path" | "first_prompt" | "last_message" | "generated_title" | "custom_name"
    >[];

    if (vectorResults.length > 0) {
      // Fetch only the sessions that passed the vector filter
      const ids = vectorResults.map((r) => r.session_id);
      const placeholders = ids.map(() => "?").join(",");
      sessions = db
        .prepare(
          `SELECT session_id, project_path, first_prompt, last_message, generated_title, custom_name
           FROM sessions WHERE session_id IN (${placeholders})`
        )
        .all(...ids) as typeof sessions;

      // Preserve vector ranking order
      const orderMap = new Map(ids.map((id, i) => [id, i]));
      sessions.sort((a, b) => (orderMap.get(a.session_id) ?? 0) - (orderMap.get(b.session_id) ?? 0));
    } else {
      // Fallback: no embeddings yet, use recent sessions
      sessions = db
        .prepare(
          `SELECT session_id, project_path, first_prompt, last_message, generated_title, custom_name
           FROM sessions WHERE archived = 0
           ORDER BY modified_at DESC LIMIT 50`
        )
        .all() as typeof sessions;
    }

    if (sessions.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Step 2: Send narrowed list to Gemini for semantic ranking
    const sessionSummaries = sessions
      .map((s, i) => {
        const project = s.project_path.split("/").pop() || "unknown";
        const title = s.custom_name || s.generated_title || "";
        const first = (s.first_prompt || "").slice(0, 300);
        const last = (s.last_message || "").slice(0, 200);
        return `[${i}] id=${s.session_id} project=${project} title="${title}" first="${first}" last="${last}"`;
      })
      .join("\n");

    const prompt = `You are searching through Claude Code sessions. The user query is: "${query}"

Here are the candidate sessions (pre-filtered by relevance):
${sessionSummaries}

Return the indices of the most relevant sessions (up to 10) with a brief snippet explaining why each is relevant. Format:
[index] snippet explaining relevance

Only return matches. If nothing matches, return "NO_RESULTS".`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `Gemini API error: ${err}`, results: [] });
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (text.includes("NO_RESULTS")) {
      return NextResponse.json({ results: [] });
    }

    // Parse results
    const results: { session_id: string; snippet: string; relevance: string }[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^\[(\d+)\]\s*(.+)$/);
      if (!match) continue;
      const idx = parseInt(match[1]);
      if (idx >= 0 && idx < sessions.length) {
        results.push({
          session_id: sessions[idx].session_id,
          snippet: match[2].trim(),
          relevance: "gemini",
        });
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg, results: [] });
  }
}
