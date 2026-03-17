import { getDb } from "@/lib/db";

export interface ProjectRow {
  project_dir: string;
  project_path: string;
  display_name: string | null;
  custom_name: string | null;
  session_count: number;
  last_activity: string | null;
}

export interface ScoredProject {
  project: ProjectRow;
  score: number;
  breakdown: { name: number; folder: number; dir: number; titles: number; recency: number };
}

export interface AutodetectMatch {
  project_dir: string;
  project_path: string;
  display_name: string;
}

export interface AutodetectDebugResult {
  matches: AutodetectMatch[];
  method: "keyword" | "gemini";
  gemini_configured: boolean;
  // Debug data
  keyword_scored: ScoredProject[];
  gemini_raw?: string;
  gemini_indices?: number[];
  gemini_matches?: AutodetectMatch[];
  total_projects: number;
}

function toMatch(p: ProjectRow): AutodetectMatch {
  return {
    project_dir: p.project_dir,
    project_path: p.project_path,
    display_name: p.custom_name || p.display_name || p.project_path.split(/[\\/]/).pop() || p.project_dir,
  };
}

export function keywordScore(prompt: string, projects: ProjectRow[], db: ReturnType<typeof getDb>): ScoredProject[] {
  const words = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  return projects.map(p => {
    const name = (p.custom_name || p.display_name || "").toLowerCase();
    const folder = (p.project_path.split(/[\\/]/).pop() || "").toLowerCase();
    const dir = p.project_dir.toLowerCase();

    const titles = db.prepare(
      `SELECT generated_title, custom_name, first_prompt
       FROM sessions WHERE project_dir = ? AND archived = 0
       ORDER BY modified_at DESC LIMIT 5`
    ).all(p.project_dir) as { generated_title: string | null; custom_name: string | null; first_prompt: string | null }[];

    const titleText = titles
      .map(t => (t.custom_name || t.generated_title || (t.first_prompt || "").slice(0, 80)).toLowerCase())
      .join(" ");

    const breakdown = { name: 0, folder: 0, dir: 0, titles: 0, recency: 0 };

    if (words.length > 0) {
      for (const w of words) {
        if (name.includes(w)) breakdown.name += 10;
        if (folder.includes(w)) breakdown.folder += 8;
        if (dir.includes(w)) breakdown.dir += 5;
        if (titleText.includes(w)) breakdown.titles += 3;
      }
    }

    const age = p.last_activity ? (Date.now() - new Date(p.last_activity).getTime()) / 86400000 : 999;
    if (age < 1) breakdown.recency = 4;
    else if (age < 7) breakdown.recency = 2;
    else if (age < 30) breakdown.recency = 1;

    const score = breakdown.name + breakdown.folder + breakdown.dir + breakdown.titles + breakdown.recency;
    return { project: p, score, breakdown };
  }).sort((a, b) => b.score - a.score);
}

export async function autodetectDebug(prompt: string, mode: "fast" | "smart" = "smart"): Promise<AutodetectDebugResult> {
  const db = getDb();

  const projects = db.prepare(
    `SELECT project_dir, project_path, display_name, custom_name, session_count, last_activity
     FROM projects WHERE session_count > 0 ORDER BY last_activity DESC`
  ).all() as ProjectRow[];

  const apiKey = process.env.GEMINI_API_KEY;
  const geminiConfigured = !!apiKey;

  // Always compute keyword scores for debug
  const keyword_scored = keywordScore(prompt, projects, db);
  const keywordTop5 = keyword_scored.slice(0, 5).map(s => s.project);

  if (mode === "fast" || !apiKey) {
    return {
      matches: keywordTop5.map(toMatch),
      method: "keyword",
      gemini_configured: geminiConfigured,
      keyword_scored,
      total_projects: projects.length,
    };
  }

  // Smart mode — try Gemini
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
        body: JSON.stringify({ contents: [{ parts: [{ text: geminiPrompt }] }] }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        matches: keywordTop5.map(toMatch),
        method: "keyword",
        gemini_configured: true,
        keyword_scored,
        gemini_raw: `HTTP ${res.status}`,
        total_projects: projects.length,
      };
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

    if (text === "NONE" || text.includes("NONE")) {
      return {
        matches: [],
        method: "gemini",
        gemini_configured: true,
        keyword_scored,
        gemini_raw: text,
        gemini_indices: [],
        gemini_matches: [],
        total_projects: projects.length,
      };
    }

    const indices = [...text.matchAll(/(\d+)/g)]
      .map(m => parseInt(m[1]))
      .filter(idx => idx >= 0 && idx < projects.length);

    const seen = new Set<number>();
    const uniqueIndices = indices.filter(idx => {
      if (seen.has(idx)) return false;
      seen.add(idx);
      return true;
    }).slice(0, 5);

    const geminiMatches = uniqueIndices.map(idx => toMatch(projects[idx]));

    return {
      matches: geminiMatches.length > 0 ? geminiMatches : keywordTop5.map(toMatch),
      method: geminiMatches.length > 0 ? "gemini" : "keyword",
      gemini_configured: true,
      keyword_scored,
      gemini_raw: text,
      gemini_indices: uniqueIndices,
      gemini_matches: geminiMatches,
      total_projects: projects.length,
    };
  } catch (err) {
    return {
      matches: keywordTop5.map(toMatch),
      method: "keyword",
      gemini_configured: true,
      keyword_scored,
      gemini_raw: `Error: ${err instanceof Error ? err.message : String(err)}`,
      total_projects: projects.length,
    };
  }
}

/** Find rank (1-based) of a path in a list of matches, or null if not found */
export function findRank(matches: AutodetectMatch[], path: string): number | null {
  const idx = matches.findIndex(m => m.project_path === path);
  return idx >= 0 ? idx + 1 : null;
}

/** Log autodetect debug result to DB */
export function logAutodetect(
  prompt: string,
  chosenPath: string,
  debug: AutodetectDebugResult
): void {
  try {
    const db = getDb();
    const chosenName = chosenPath.split(/[\\/]/).pop() || chosenPath;

    const keywordTop5 = debug.keyword_scored.slice(0, 5).map(s => ({
      name: s.project.custom_name || s.project.display_name || s.project.project_path.split(/[\\/]/).pop(),
      path: s.project.project_path,
      score: s.score,
      breakdown: s.breakdown,
    }));

    const keywordRank = findRank(
      debug.keyword_scored.map(s => toMatch(s.project)),
      chosenPath
    );

    const geminiRank = debug.gemini_matches
      ? findRank(debug.gemini_matches, chosenPath)
      : null;

    const geminiTop5 = debug.gemini_matches
      ? JSON.stringify(debug.gemini_matches.map(m => ({ name: m.display_name, path: m.project_path })))
      : null;

    db.prepare(
      `INSERT INTO autodetect_log
       (prompt, chosen_path, chosen_name, keyword_rank, gemini_rank, keyword_top5, gemini_top5, keyword_all_scores, gemini_raw, gemini_method, total_projects)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      prompt.slice(0, 500),
      chosenPath,
      chosenName,
      keywordRank,
      geminiRank,
      JSON.stringify(keywordTop5),
      geminiTop5,
      JSON.stringify(debug.keyword_scored.map(s => ({
        name: s.project.custom_name || s.project.display_name || s.project.project_path.split(/[\\/]/).pop(),
        path: s.project.project_path,
        score: s.score,
      }))),
      debug.gemini_raw ?? null,
      debug.method,
      debug.total_projects
    );
  } catch {
    // Non-critical
  }
}
