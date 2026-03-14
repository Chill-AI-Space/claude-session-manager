import { NextRequest } from "next/server";
import { getSetting, logAction } from "@/lib/db";
import os from "os";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const token = getSetting("github_token");
  const repo = getSetting("github_repo") || "Chill-AI-Space/claude-session-manager";

  if (!token) {
    return Response.json(
      { error: "GitHub token not configured. Set github_token in Settings." },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { title, description, sessionId, labels } = body as {
    title?: string;
    description?: string;
    sessionId?: string;
    labels?: string[];
  };

  if (!title?.trim()) {
    return Response.json({ error: "Title is required" }, { status: 400 });
  }

  // Build issue body with auto-context
  const platform = process.platform;
  const nodeVersion = process.version;
  const hostname = os.hostname();
  const contextLines = [
    description?.trim() || "",
    "",
    "---",
    "**Auto-attached context:**",
    `- Platform: ${platform} (${os.release()})`,
    `- Node.js: ${nodeVersion}`,
    `- Host: ${hostname}`,
    sessionId ? `- Session: \`${sessionId}\`` : "",
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "claude-session-manager",
      },
      body: JSON.stringify({
        title: title.trim(),
        body: contextLines,
        labels: labels || ["bug", "from-ui"],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      logAction("service", "create_failed", err, sessionId);
      return Response.json(
        { error: `GitHub API error: ${res.status} ${err.slice(0, 200)}` },
        { status: res.status }
      );
    }

    const issue = await res.json();
    logAction("service", "created", `#${issue.number}: ${title}`, sessionId);
    return Response.json({
      ok: true,
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAction("service", "create_error", msg, sessionId);
    return Response.json({ error: msg }, { status: 500 });
  }
}
