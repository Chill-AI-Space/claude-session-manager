import { NextRequest, NextResponse } from "next/server";
import { getDb, searchSessionContent } from "@/lib/db";
import { getActiveSessionIds } from "@/lib/process-detector";
import { SessionRow, SessionListItem } from "@/lib/types";
import { fetchAllRemoteSessions } from "@/lib/remote-compute";
import { ensureCodexBackgroundScanner } from "@/lib/codex-background-scanner";
import { codexSessionCompleted } from "@/lib/codex-db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Ensure Codex sessions are scanned periodically (no-op if already running)
  ensureCodexBackgroundScanner();

  const searchParams = request.nextUrl.searchParams;
  const project = searchParams.get("project");
  const search = searchParams.get("search");
  const tag = searchParams.get("tag");
  const ids = searchParams.get("ids"); // comma-separated session IDs
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
    const projectList = project.split(",").filter(Boolean);
    if (projectList.length === 1) {
      conditions.push("project_dir = @project");
      filterParams.project = projectList[0];
    } else {
      const placeholders = projectList.map((_, i) => `@proj${i}`).join(",");
      conditions.push(`project_dir IN (${placeholders})`);
      projectList.forEach((p, i) => { filterParams[`proj${i}`] = p; });
    }
  }
  if (search) {
    // Broad non-LLM search: title + prompt + last message for better recall.
    // Full content FTS still runs in parallel for deeper matches.
    conditions.push(
      "(" +
      "generated_title LIKE @search OR " +
      "custom_name LIKE @search OR " +
      "session_id LIKE @search OR " +
      "first_prompt LIKE @search OR " +
      "last_message LIKE @search" +
      ")"
    );
    filterParams.search = `%${search}%`;
  }
  if (search && !ids) {
    const contentIds = searchSessionContent(search);
    if (contentIds.length > 0) {
      const placeholders = contentIds.map((_, i) => `@searchId${i}`).join(",");
      const contentCondition = `session_id IN (${placeholders})`;
      if (conditions.length > 0) {
        const prev = conditions.pop()!;
        conditions.push(`(${prev} OR ${contentCondition})`);
      } else {
        conditions.push(contentCondition);
      }
      contentIds.forEach((id, i) => { filterParams[`searchId${i}`] = id; });
    }
  }
  if (tag) {
    conditions.push("tags LIKE @tag");
    filterParams.tag = `%"${tag}"%`;
  }
  if (ids) {
    const idList = ids.split(",").filter(Boolean);
    if (idList.length > 0) {
      const placeholders = idList.map((_, i) => `@id${i}`).join(",");
      conditions.push(`session_id IN (${placeholders})`);
      idList.forEach((id, i) => { filterParams[`id${i}`] = id; });
    }
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

  // Explicit columns — truncate large text fields for sidebar (UI only shows 100-200 chars)
  const rows = db
    .prepare(
      `SELECT session_id, jsonl_path, project_dir, project_path,
              git_branch, claude_version, model,
              SUBSTR(first_prompt, 1, 500) as first_prompt,
              SUBSTR(last_message, 1, 500) as last_message,
              generated_title, custom_name, tags, pinned, archived,
              message_count, total_input_tokens, total_output_tokens,
              created_at, modified_at, file_mtime, file_size, last_scanned_at,
              last_message_role, has_result, agent_type
       FROM sessions ${whereClause} ${sortClause} LIMIT @limit OFFSET @offset`
    )
    .all({ ...filterParams, limit, offset }) as SessionRow[];

  // Get active session IDs
  let activeIds: Set<string>;
  try {
    activeIds = getActiveSessionIds();
  } catch {
    activeIds = new Set();
  }

  const sessions: SessionListItem[] = rows.map((row) => {
    const agentType = (row as SessionRow & { agent_type?: string }).agent_type ?? "claude";
    const fileAgeMs = Date.now() - row.file_mtime;
    let isActive: boolean;
    if (agentType === "codex") {
      isActive = !codexSessionCompleted(row.jsonl_path) && fileAgeMs < 5 * 60 * 1000;
    } else if (agentType === "forge") {
      isActive = fileAgeMs < 5 * 60 * 1000;
    } else {
      isActive = activeIds.has(row.session_id);
    }

    return {
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
      is_active: isActive,
      last_message_role: (row as SessionRow & { last_message_role?: string }).last_message_role ?? null,
      has_result: !!row.has_result,
      agent_type: agentType,
    };
  });

  const totalCount = db
    .prepare(`SELECT COUNT(*) as count FROM sessions ${whereClause}`)
    .get(filterParams) as { count: number };

  // Merge remote sessions if requested (default: true when no project filter)
  const includeRemote = searchParams.get("include_remote") !== "false";
  let allSessions: (SessionListItem | Record<string, unknown>)[] = sessions;
  const remoteMeta: { nodeId: string; nodeName: string; count: number; error?: string }[] = [];

  if (includeRemote && offset === 0) {
    try {
      const remoteResults = await fetchAllRemoteSessions({ limit: Math.max(limit, 100), search: search || undefined });
      for (const result of remoteResults) {
        remoteMeta.push({
          nodeId: result.nodeId,
          nodeName: result.nodeName,
          count: result.sessions.length,
          error: result.error,
        });
        allSessions = [...allSessions, ...result.sessions];
      }
      // Sort merged list by modified_at descending
      allSessions.sort((a, b) => {
        const aTime = String((a as Record<string, unknown>).modified_at || "");
        const bTime = String((b as Record<string, unknown>).modified_at || "");
        return bTime.localeCompare(aTime);
      });
    } catch {
      // Remote fetch failed — return local-only
    }
  }

  return NextResponse.json({
    sessions: allSessions,
    total: totalCount.count,
    limit,
    offset,
    remote: remoteMeta.length > 0 ? remoteMeta : undefined,
  });
}
