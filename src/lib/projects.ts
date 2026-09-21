import type Database from "better-sqlite3";
import { ProjectListItem } from "./types";

interface ProjectAggregateRow {
  project_dir: string;
  project_path: string;
  display_name: string | null;
  custom_name: string | null;
  color: string | null;
  session_count: number;
  last_activity: string | null;
}

// SQL expression: best ISO timestamp across modified_at and file_mtime (Codex uses file_mtime as authoritative)
const LAST_ACTIVITY_EXPR = `
  CASE WHEN COALESCE(s.file_mtime, 0) > COALESCE(CAST(strftime('%s', s.modified_at) AS INTEGER) * 1000, 0)
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.file_mtime / 1000.0, 'unixepoch')
    ELSE s.modified_at END`;

// Used by syncProjectsFromSessions — only active (non-archived) projects, session_count = non-archived
const SYNC_PROJECTS_SQL = `
  SELECT
    s.project_dir,
    COALESCE(MAX(NULLIF(s.project_path, '')), p.project_path, s.project_dir) as project_path,
    p.display_name,
    p.custom_name,
    p.color,
    COUNT(*) as session_count,
    MAX(${LAST_ACTIVITY_EXPR}) as last_activity
  FROM sessions s
  LEFT JOIN projects p ON p.project_dir = s.project_dir
  WHERE s.archived = 0
  GROUP BY s.project_dir
`;

// Used by listProjectsFromSessions — all projects, session_count = non-archived only.
// last_activity prefers active sessions (to match session_count); falls back to
// archived sessions only for projects that have no active session left at all,
// so a fully-archived project doesn't show a null/stale last_activity.
const LIST_PROJECTS_SQL = `
  SELECT
    s.project_dir,
    COALESCE(MAX(NULLIF(s.project_path, '')), p.project_path, s.project_dir) as project_path,
    p.display_name,
    p.custom_name,
    p.color,
    SUM(CASE WHEN s.archived = 0 THEN 1 ELSE 0 END) as session_count,
    COALESCE(
      MAX(CASE WHEN s.archived = 0 THEN (${LAST_ACTIVITY_EXPR}) END),
      MAX(${LAST_ACTIVITY_EXPR})
    ) as last_activity
  FROM sessions s
  LEFT JOIN projects p ON p.project_dir = s.project_dir
  GROUP BY s.project_dir
`;

function fallbackDisplayName(projectPath: string, projectDir: string): string {
  return projectPath.split(/[\\/]/).pop() || projectDir;
}

function toProjectListItem(row: ProjectAggregateRow): ProjectListItem {
  return {
    project_dir: row.project_dir,
    project_path: row.project_path,
    display_name:
      row.custom_name ||
      row.display_name ||
      fallbackDisplayName(row.project_path, row.project_dir),
    custom_name: row.custom_name,
    session_count: row.session_count,
    last_activity: row.last_activity,
    color: row.color,
  };
}

export function listProjectsFromSessions(db: Database.Database): ProjectListItem[] {
  const rows = db
    .prepare(`${LIST_PROJECTS_SQL} ORDER BY last_activity DESC`)
    .all() as ProjectAggregateRow[];

  return rows.map(toProjectListItem);
}

export function syncProjectsFromSessions(db: Database.Database): number {
  const rows = db.prepare(SYNC_PROJECTS_SQL).all() as ProjectAggregateRow[];

  const upsertProject = db.prepare(`
    INSERT INTO projects (project_dir, project_path, display_name, session_count, last_activity)
    VALUES (@project_dir, @project_path, @display_name, @session_count, @last_activity)
    ON CONFLICT(project_dir) DO UPDATE SET
      project_path = excluded.project_path,
      display_name = COALESCE(projects.custom_name, excluded.display_name),
      session_count = excluded.session_count,
      last_activity = excluded.last_activity
  `);

  const updateProjects = db.transaction((items: ProjectListItem[]) => {
    for (const project of items) {
      upsertProject.run({
        project_dir: project.project_dir,
        project_path: project.project_path,
        display_name: project.display_name,
        session_count: project.session_count,
        last_activity: project.last_activity,
      });
    }
  });

  updateProjects(rows.map(toProjectListItem));
  return rows.length;
}
