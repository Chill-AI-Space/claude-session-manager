import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// API-equivalent pricing (for reference; Claude Code is subscription-based)
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":             { input: 15,  output: 75  },
  "claude-opus-4-5-20251101":    { input: 15,  output: 75  },
  "claude-sonnet-4-6":           { input: 3,   output: 15  },
  "claude-sonnet-4-5-20250929":  { input: 3,   output: 15  },
};
const DEFAULT_PRICE = { input: 3, output: 15 };

function calcCost(model: string | null, inputTok: number, outputTok: number): number {
  const p = model ? (MODEL_PRICES[model] ?? DEFAULT_PRICE) : DEFAULT_PRICE;
  return (inputTok / 1_000_000) * p.input + (outputTok / 1_000_000) * p.output;
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const period = parseInt(req.nextUrl.searchParams.get("period") ?? "30");

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(total_input_tokens)  as total_input,
      SUM(total_output_tokens) as total_output,
      COUNT(DISTINCT DATE(modified_at)) as active_days,
      MIN(created_at) as oldest,
      MAX(modified_at) as newest
    FROM sessions WHERE archived = 0
  `).get() as {
    total_sessions: number; total_input: number; total_output: number;
    active_days: number; oldest: string; newest: string;
  };

  const daily = (db.prepare(`
    SELECT
      DATE(modified_at) as day,
      COUNT(*)                   as sessions,
      SUM(total_input_tokens)    as input_tokens,
      SUM(total_output_tokens)   as output_tokens,
      GROUP_CONCAT(DISTINCT COALESCE(model, '')) as models
    FROM sessions
    WHERE archived = 0 AND modified_at >= DATE('now', ?)
    GROUP BY DATE(modified_at)
    ORDER BY day ASC
  `).all(`-${period} days`) as Array<{
    day: string; sessions: number; input_tokens: number; output_tokens: number; models: string;
  }>).map((row) => ({
    ...row,
    cost: calcCost(null, row.input_tokens, row.output_tokens),
  }));

  const projects = (db.prepare(`
    SELECT
      COALESCE(project_path, project_dir) as project,
      COUNT(*)                   as sessions,
      SUM(total_input_tokens)    as input_tokens,
      SUM(total_output_tokens)   as output_tokens
    FROM sessions
    WHERE archived = 0 AND modified_at >= DATE('now', ?)
    GROUP BY project_dir
    ORDER BY input_tokens DESC
    LIMIT 15
  `).all(`-${period} days`) as Array<{
    project: string; sessions: number; input_tokens: number; output_tokens: number;
  }>).map((row) => ({
    ...row,
    cost: calcCost(null, row.input_tokens, row.output_tokens),
    label: row.project?.split(/[\\/]/).slice(-2).join("/") ?? "unknown",
  }));

  const models = (db.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*)                   as sessions,
      SUM(total_input_tokens)    as input_tokens,
      SUM(total_output_tokens)   as output_tokens
    FROM sessions
    WHERE archived = 0
    GROUP BY model
    ORDER BY input_tokens DESC
  `).all() as Array<{
    model: string; sessions: number; input_tokens: number; output_tokens: number;
  }>).map((row) => ({
    ...row,
    cost: calcCost(row.model, row.input_tokens, row.output_tokens),
  }));

  const topSessions = db.prepare(`
    SELECT
      session_id,
      COALESCE(generated_title, custom_name, substr(first_prompt, 1, 60)) as title,
      COALESCE(project_path, project_dir) as project,
      model,
      total_input_tokens,
      total_output_tokens,
      modified_at
    FROM sessions
    WHERE archived = 0 AND total_input_tokens IS NOT NULL
    ORDER BY total_input_tokens DESC
    LIMIT 20
  `).all() as Array<{
    session_id: string; title: string; project: string; model: string;
    total_input_tokens: number; total_output_tokens: number; modified_at: string;
  }>;

  // Compute total estimated cost
  const totalCost = models.reduce((acc, m) => acc + m.cost, 0);

  return NextResponse.json({
    summary: { ...summary, total_cost: totalCost },
    daily,
    projects,
    models,
    top_sessions: topSessions,
  });
}
