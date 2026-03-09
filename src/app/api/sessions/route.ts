import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getActiveSessionIds } from "@/lib/process-detector";
import { SessionRow, SessionListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const project = searchParams.get("project");
  const search = searchParams.get("search");
  const tag = searchParams.get("tag");
  const sort = searchParams.get("sort") || "modified";
  const limit = parseInt(searchParams.get("limit") || "100");
  const offset = parseInt(searchParams.get("offset") || "0");
  const showArchived = searchParams.get("archived") === "true";

  const db = getDb();

  // Build WHERE clause shared by both data and count queries
  const conditions: string[] = [];
  const filterParams: Record<string, string | number> = {};

  if (!showArchived) {
    conditions.push("archived = 0");
  }
  if (project) {
    conditions.push("project_dir = @project");
    filterParams.project = project;
  }
  if (search) {
    conditions.push(
      "(first_prompt LIKE @search OR last_message LIKE @search OR generated_title LIKE @search OR custom_name LIKE @search OR session_id LIKE @search)"
    );
    filterParams.search = `%${search}%`;
  }
  if (tag) {
    conditions.push("tags LIKE @tag");
    filterParams.tag = `%"${tag}"%`;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  let sortClause: string;
  switch (sort) {
    case "created":
      sortClause = "ORDER BY pinned DESC, created_at DESC";
      break;
    case "tokens":
      sortClause = "ORDER BY pinned DESC, (total_input_tokens + total_output_tokens) DESC";
      break;
    default:
      sortClause = "ORDER BY pinned DESC, modified_at DESC";
      break;
  }

  const rows = db
    .prepare(
      `SELECT * FROM sessions ${whereClause} ${sortClause} LIMIT @limit OFFSET @offset`
    )
    .all({ ...filterParams, limit, offset }) as SessionRow[];

  // Get active session IDs
  let activeIds: Set<string>;
  try {
    activeIds = getActiveSessionIds();
  } catch {
    activeIds = new Set();
  }

  const sessions: SessionListItem[] = rows.map((row) => ({
    session_id: row.session_id,
    project_dir: row.project_dir,
    project_path: row.project_path,
    display_name:
      row.project_path.split(/[\\/]/).pop() || row.project_dir,
    first_prompt: row.first_prompt,
    last_message: row.last_message,
    generated_title: row.generated_title,
    custom_name: row.custom_name,
    tags: row.tags ? JSON.parse(row.tags) : [],
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    message_count: row.message_count,
    model: row.model,
    git_branch: row.git_branch,
    created_at: row.created_at,
    modified_at: row.modified_at,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    is_active: activeIds.has(row.session_id),
    last_message_role: (row as SessionRow & { last_message_role?: string }).last_message_role ?? null,
  }));

  const totalCount = db
    .prepare(`SELECT COUNT(*) as count FROM sessions ${whereClause}`)
    .get(filterParams) as { count: number };

  return NextResponse.json({
    sessions,
    total: totalCount.count,
    limit,
    offset,
  });
}
