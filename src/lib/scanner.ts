import { getDb } from "./db";
import { globSync } from "glob";
import fs from "fs";
import path from "path";

const CLAUDE_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "projects"
);

interface ScanResult {
  sessionsScanned: number;
  sessionsSkipped: number;
  projectsFound: number;
  duration: number;
}

interface JsonlMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch: string | null;
  claudeVersion: string | null;
  model: string | null;
  firstPrompt: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  modifiedAt: string;
}

function extractMetadataFromJsonl(filePath: string): JsonlMetadata | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    let sessionId = "";
    let projectPath = "";
    let gitBranch: string | null = null;
    let claudeVersion: string | null = null;
    let model: string | null = null;
    let firstPrompt: string | null = null;
    let messageCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let createdAt = "";
    let modifiedAt = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        if (obj.type === "user" || obj.type === "assistant") {
          messageCount++;

          if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
          if (!projectPath && obj.cwd) projectPath = obj.cwd;
          if (!gitBranch && obj.gitBranch && obj.gitBranch !== "HEAD")
            gitBranch = obj.gitBranch;
          if (!claudeVersion && obj.version) claudeVersion = obj.version;

          const ts = obj.timestamp;
          if (ts) {
            if (!createdAt) createdAt = ts;
            modifiedAt = ts;
          }

          if (obj.type === "user" && !firstPrompt) {
            const msg = obj.message;
            if (msg) {
              const text =
                typeof msg.content === "string"
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content
                        .filter(
                          (b: { type: string }) => b.type === "text"
                        )
                        .map((b: { text: string }) => b.text)
                        .join("")
                    : "";
              if (
                text &&
                !text.startsWith("{") &&
                !text.startsWith("[Request interrupted") &&
                text.trim().length > 5
              ) {
                firstPrompt = text.slice(0, 500);
              }
            }
          }

          if (obj.type === "assistant" && obj.message) {
            if (obj.message.model) model = obj.message.model;
            const usage = obj.message.usage;
            if (usage) {
              totalInputTokens +=
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0);
              totalOutputTokens += usage.output_tokens || 0;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!sessionId) {
      sessionId = path.basename(filePath, ".jsonl");
    }

    if (!createdAt) {
      const stat = fs.statSync(filePath);
      createdAt = stat.birthtime.toISOString();
      modifiedAt = stat.mtime.toISOString();
    }

    return {
      sessionId,
      projectPath,
      gitBranch,
      claudeVersion,
      model,
      firstPrompt,
      messageCount,
      totalInputTokens,
      totalOutputTokens,
      createdAt,
      modifiedAt,
    };
  } catch {
    return null;
  }
}

export async function scanSessions(
  mode: "full" | "incremental" = "incremental"
): Promise<ScanResult> {
  const start = Date.now();
  const db = getDb();

  const jsonlFiles = globSync("**/*.jsonl", {
    cwd: CLAUDE_DIR,
    absolute: true,
  });

  let sessionsScanned = 0;
  let sessionsSkipped = 0;
  const projectDirs = new Set<string>();

  // Get existing mtimes for incremental scan
  const existingMtimes = new Map<string, number>();
  if (mode === "incremental") {
    const rows = db
      .prepare("SELECT session_id, file_mtime FROM sessions")
      .all() as { session_id: string; file_mtime: number }[];
    for (const row of rows) {
      existingMtimes.set(row.session_id, row.file_mtime);
    }
  }

  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, jsonl_path, project_dir, project_path,
      git_branch, claude_version, model, first_prompt,
      message_count, total_input_tokens, total_output_tokens,
      created_at, modified_at, file_mtime, file_size, last_scanned_at
    ) VALUES (
      @session_id, @jsonl_path, @project_dir, @project_path,
      @git_branch, @claude_version, @model, @first_prompt,
      @message_count, @total_input_tokens, @total_output_tokens,
      @created_at, @modified_at, @file_mtime, @file_size, @last_scanned_at
    )
    ON CONFLICT(session_id) DO UPDATE SET
      jsonl_path = @jsonl_path,
      project_dir = @project_dir,
      project_path = @project_path,
      git_branch = COALESCE(@git_branch, sessions.git_branch),
      claude_version = COALESCE(@claude_version, sessions.claude_version),
      model = COALESCE(@model, sessions.model),
      first_prompt = COALESCE(@first_prompt, sessions.first_prompt),
      message_count = @message_count,
      total_input_tokens = @total_input_tokens,
      total_output_tokens = @total_output_tokens,
      created_at = @created_at,
      modified_at = @modified_at,
      file_mtime = @file_mtime,
      file_size = @file_size,
      last_scanned_at = @last_scanned_at
  `);

  const upsertProject = db.prepare(`
    INSERT INTO projects (project_dir, project_path, display_name, session_count, last_activity)
    VALUES (@project_dir, @project_path, @display_name, @session_count, @last_activity)
    ON CONFLICT(project_dir) DO UPDATE SET
      project_path = COALESCE(@project_path, projects.project_path),
      display_name = COALESCE(projects.custom_name, @display_name),
      session_count = @session_count,
      last_activity = @last_activity
  `);

  const batchInsert = db.transaction(() => {
    for (const filePath of jsonlFiles) {
      const sessionId = path.basename(filePath, ".jsonl");
      // Skip non-UUID files (like sessions-index.json parsed as jsonl)
      if (
        !sessionId.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        )
      ) {
        continue;
      }

      const stat = fs.statSync(filePath);
      const fileMtime = stat.mtimeMs;

      // Incremental: skip if mtime hasn't changed
      if (mode === "incremental" && existingMtimes.has(sessionId)) {
        const existingMtime = existingMtimes.get(sessionId)!;
        if (Math.abs(existingMtime - fileMtime) < 1000) {
          sessionsSkipped++;
          // Still track project dir
          const dirName = path.basename(path.dirname(filePath));
          projectDirs.add(dirName);
          continue;
        }
      }

      const metadata = extractMetadataFromJsonl(filePath);
      if (!metadata) continue;

      const dirName = path.basename(path.dirname(filePath));
      projectDirs.add(dirName);

      upsertSession.run({
        session_id: sessionId,
        jsonl_path: filePath,
        project_dir: dirName,
        project_path: metadata.projectPath || dirToPath(dirName),
        git_branch: metadata.gitBranch,
        claude_version: metadata.claudeVersion,
        model: metadata.model,
        first_prompt: metadata.firstPrompt,
        message_count: metadata.messageCount,
        total_input_tokens: metadata.totalInputTokens,
        total_output_tokens: metadata.totalOutputTokens,
        created_at: metadata.createdAt,
        modified_at: metadata.modifiedAt,
        file_mtime: fileMtime,
        file_size: stat.size,
        last_scanned_at: new Date().toISOString(),
      });

      sessionsScanned++;
    }

    // Update projects
    for (const projectDir of projectDirs) {
      const stats = db
        .prepare(
          `SELECT COUNT(*) as count, MAX(modified_at) as last_activity,
           MAX(project_path) as project_path
           FROM sessions WHERE project_dir = ?`
        )
        .get(projectDir) as {
        count: number;
        last_activity: string;
        project_path: string;
      };

      const projectPath = stats.project_path || dirToPath(projectDir);

      upsertProject.run({
        project_dir: projectDir,
        project_path: projectPath,
        display_name: projectPath.split("/").pop() || projectDir,
        session_count: stats.count,
        last_activity: stats.last_activity,
      });
    }
  });

  batchInsert();

  return {
    sessionsScanned,
    sessionsSkipped,
    projectsFound: projectDirs.size,
    duration: Date.now() - start,
  };
}

function dirToPath(dirName: string): string {
  return dirName.replace(/-/g, "/").replace(/^\//, "/");
}
