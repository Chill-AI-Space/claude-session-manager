import { getDb } from "@/lib/db";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

interface SessionForTitle {
  session_id: string;
  first_prompt: string | null;
  last_message: string | null;
  project_path: string;
}

function runClaude(prompt: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "text"],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on("error", reject);

    proc.stdin.write(prompt);
    proc.stdin.end();

    // Timeout after 90 seconds
    setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Timeout generating titles"));
    }, 90_000);
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(body.limit || 20, 50);
  const force = body.force === true;

  const db = getDb();

  // Find sessions that need titles
  const whereClause = force
    ? "WHERE first_prompt IS NOT NULL"
    : "WHERE generated_title IS NULL AND first_prompt IS NOT NULL";

  const sessions = db
    .prepare(
      `SELECT session_id, first_prompt, last_message, project_path
       FROM sessions ${whereClause}
       ORDER BY modified_at DESC LIMIT ?`
    )
    .all(limit) as SessionForTitle[];

  if (sessions.length === 0) {
    return Response.json({ generated: 0, message: "All sessions have titles" });
  }

  // Build env without Claude Code vars
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE")) delete env[key];
  }

  // Batch: send all sessions at once to minimize API calls
  const sessionsText = sessions
    .map((s, i) => {
      const project = s.project_path.split("/").pop() || "unknown";
      const first = (s.first_prompt || "").slice(0, 200).replace(/\n/g, " ").replace(/"/g, "'");
      const last = (s.last_message || "").slice(0, 150).replace(/\n/g, " ").replace(/"/g, "'");
      return `[${i}] project=${project} | first: ${first} | last: ${last}`;
    })
    .join("\n");

  const prompt = `Generate a short descriptive title (5-10 words, no quotes) for each Claude Code session below. The title should capture what the session was about. Reply with ONLY numbered lines like:
[0] Title here
[1] Another title

${sessionsText}`;

  try {
    const stdout = await runClaude(prompt, env);

    const updateStmt = db.prepare(
      "UPDATE sessions SET generated_title = ? WHERE session_id = ?"
    );

    let generated = 0;
    const lines = stdout.split("\n");

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\]\s*(.+)$/);
      if (!match) continue;

      const idx = parseInt(match[1]);
      const title = match[2].trim().replace(/^["']|["']$/g, "");

      if (idx >= 0 && idx < sessions.length && title.length > 2) {
        updateStmt.run(title, sessions[idx].session_id);
        generated++;
      }
    }

    return Response.json({ generated, total: sessions.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
