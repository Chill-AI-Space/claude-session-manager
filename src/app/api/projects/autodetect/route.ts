import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

interface ProjectRow {
  project_dir: string;
  project_path: string;
  display_name: string | null;
  custom_name: string | null;
  session_count: number;
  last_activity: string | null;
}

function toMatch(p: ProjectRow) {
  return {
    project_dir: p.project_dir,
    project_path: p.project_path,
    display_name: p.custom_name || p.display_name || p.project_path.split(/[\\/]/).pop() || p.project_dir,
  };
}

/** Fast keyword scoring — no API call, instant results */
function keywordMatch(prompt: string, projects: ProjectRow[], db: ReturnType<typeof getDb>): typeof projects {
  const words = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return projects.slice(0, 5);

  const scored = projects.map(p => {
    const name = (p.custom_name || p.display_name || "").toLowerCase();
    const folder = (p.project_path.split(/[\\/]/).pop() || "").toLowerCase();
    const dir = p.project_dir.toLowerCase();

    // Get recent titles for keyword matching
    const titles = db.prepare(
      `SELECT generated_title, custom_name, first_prompt
       FROM sessions WHERE project_dir = ? AND archived = 0
       ORDER BY modified_at DESC LIMIT 5`
    ).all(p.project_dir) as { generated_title: string | null; custom_name: string | null; first_prompt: string | null }[];

    const titleText = titles
      .map(t => (t.custom_name || t.generated_title || (t.first_prompt || "").slice(0, 80)).toLowerCase())
      .join(" ");

    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 10;
      if (folder.includes(w)) score += 8;
      if (dir.includes(w)) score += 5;
      if (titleText.includes(w)) score += 3;
    }

    // Recency bonus — more recent projects get a slight boost
    const age = p.last_activity ? (Date.now() - new Date(p.last_activity).getTime()) / 86400000 : 999;
    if (age < 1) score += 4;
    else if (age < 7) score += 2;
    else if (age < 30) score += 1;

    return { project: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(s => s.project);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const prompt = body.prompt;
  const mode = body.mode || "smart"; // "fast" = keyword only, "smart" = Gemini

  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  const db = getDb();

  const projects = db.prepare(
    `SELECT project_dir, project_path, display_name, custom_name, session_count, last_activity
     FROM projects WHERE session_count > 0 ORDER BY last_activity DESC`
  ).all() as ProjectRow[];

  if (projects.length === 0) {
    return NextResponse.json({ error: "No projects found" }, { status: 404 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const geminiConfigured = !!apiKey;

  // Fast mode — instant keyword matching, no API call
  if (mode === "fast") {
    const matched = keywordMatch(prompt, projects, db);
    return NextResponse.json({ matches: matched.map(toMatch), method: "keyword", gemini_configured: geminiConfigured });
  }

  // Smart mode — try Gemini, fall back to keyword match
  if (!apiKey) {
    const matched = keywordMatch(prompt, projects, db);
    return NextResponse.json({ matches: matched.map(toMatch), method: "keyword", gemini_configured: false });
  }

  const projectContexts = projects.map((p, i) => {
    const titles = db.prepare(
      `SELECT generated_title, custom_name, first_prompt
       FROM sessions WHERE project_dir = ? AND archived = 0
       ORDER BY modified_at DESC LIMIT 8`
    ).all(p.project_dir) as { generated_title: string | null; custom_name: string | null; first_prompt: string | null }[];

    const name = p.custom_name || p.display_name || p.project_path.split(/[\\/]/).pop() || p.project_dir;
    const folder = p.project_path.split(/[\\/]/).pop() || p.project_dir;
    const titleList = titles
      .map(t => t.custom_name || t.generated_title || (t.first_prompt || "").slice(0, 100))
      .filter(Boolean)
      .join("; ");

    return `[${i}] name="${name}" folder="${folder}" path="${p.project_path}" sessions=${p.session_count} recent_titles: ${titleList || "none"}`;
  }).join("\n");

  const geminiPrompt = `You are a project folder matcher. The user wants to start a new Claude Code session with this prompt:

"${prompt.slice(0, 500)}"

Here are the available project folders with their recent session titles:
${projectContexts}

Pick the TOP 5 most relevant project folders for this prompt, ranked by relevance. Consider:
- Project name and folder name
- Recent session titles (they describe what work happens in each project)
- The nature of the user's prompt

Respond with ONLY the index numbers separated by commas (e.g. "3,1,7,0,5"). If no project is a good match, respond with "NONE". If fewer than 5 are relevant, return only the relevant ones.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      // Gemini failed — fall back to keyword match
      const matched = keywordMatch(prompt, projects, db);
      return NextResponse.json({ matches: matched.map(toMatch), method: "keyword" });
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

    if (text === "NONE" || text.includes("NONE")) {
      return NextResponse.json({ matches: [], method: "gemini" });
    }

    const indices = [...text.matchAll(/(\d+)/g)]
      .map(m => parseInt(m[1]))
      .filter(idx => idx >= 0 && idx < projects.length);

    if (indices.length === 0) {
      const matched = keywordMatch(prompt, projects, db);
      return NextResponse.json({ matches: matched.map(toMatch), method: "keyword" });
    }

    const seen = new Set<number>();
    const uniqueIndices = indices.filter(idx => {
      if (seen.has(idx)) return false;
      seen.add(idx);
      return true;
    }).slice(0, 5);

    const matches = uniqueIndices.map(idx => toMatch(projects[idx]));
    return NextResponse.json({ matches, method: "gemini" });
  } catch {
    // Timeout or network error — fall back to keyword match
    const matched = keywordMatch(prompt, projects, db);
    return NextResponse.json({ matches: matched.map(toMatch), method: "keyword" });
  }
}
