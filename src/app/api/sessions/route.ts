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

  let query = `SELECT * FROM sessions WHERE 1=1`;
  const params: Record<string, string | number> = {};

  if (!showArchived) {
    query += ` AND archived = 0`;
  }

  if (project) {
    query += ` AND project_dir = @project`;
    params.project = project;
  }

  if (search) {
    query += ` AND (first_prompt LIKE @search OR custom_name LIKE @search OR session_id LIKE @search)`;
    params.search = `%${search}%`;
  }

  if (tag) {
    query += ` AND tags LIKE @tag`;
    params.tag = `%"${tag}"%`;
  }

  const sortClause =
    sort === "created"
      ? "ORDER BY pinned DESC, created_at DESC"
      : sort === "tokens"
        ? "ORDER BY pinned DESC, (total_input_tokens + total_output_tokens) DESC"
        : "ORDER BY pinned DESC, modified_at DESC";

  query += ` ${sortClause} LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(query).all(params) as SessionRow[];

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
      row.project_path.split("/").pop() || row.project_dir,
    first_prompt: row.first_prompt,
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
  }));

  const totalCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM sessions WHERE 1=1${!showArchived ? " AND archived = 0" : ""}${project ? " AND project_dir = @projectCount" : ""}${search ? " AND (first_prompt LIKE @searchCount OR custom_name LIKE @searchCount)" : ""}`
    )
    .get({
      ...(project ? { projectCount: project } : {}),
      ...(search ? { searchCount: `%${search}%` } : {}),
    }) as { count: number };

  return NextResponse.json({
    sessions,
    total: totalCount.count,
    limit,
    offset,
  });
}
