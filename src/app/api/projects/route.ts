import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ProjectRow, ProjectListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM projects ORDER BY last_activity DESC`
    )
    .all() as ProjectRow[];

  const projects: ProjectListItem[] = rows.map((row) => ({
    project_dir: row.project_dir,
    project_path: row.project_path,
    display_name:
      row.custom_name ||
      row.display_name ||
      row.project_path.split("/").pop() ||
      row.project_dir,
    custom_name: row.custom_name,
    session_count: row.session_count,
    last_activity: row.last_activity,
    color: row.color,
  }));

  return NextResponse.json({ projects });
}
