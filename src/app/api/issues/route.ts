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
  const {
    title,
    description,
    sessionId,
    session_id,
    labels,
    category,
    project_path,
  } = body as {
    title?: string;
    description?: string;
    sessionId?: string;
    session_id?: string;
    labels?: string[];
    category?: string;
    project_path?: string;
  };

  // Category labels for UI-submitted issues
  const categoryLabels: Record<string, string> = {
    critical_problem: "Critical problem",
    repeated_bug: "Repeated bug",
    one_time_bug: "One-time bug",
    idea: "Idea / Proposal",
    must_have_feature: "Must-have feature",
  };

  // Build title: explicit title wins, otherwise derive from category
  const issueTitle = title?.trim()
    || (category ? `[${categoryLabels[category] || category}] ${(description || "").trim().split("\n")[0].slice(0, 80)}` : "");

  if (!issueTitle) {
    return Response.json({ error: "Title or category is required" }, { status: 400 });
  }

  const effectiveSessionId = sessionId || session_id;

  // Build issue body with auto-context
  const platform = process.platform;
  const nodeVersion = process.version;
  const hostname = os.hostname();
  const contextLines = [
    description?.trim() || "",
    "",
    "---",
    "**Auto-attached context:**",
    category ? `- Category: ${categoryLabels[category] || category}` : "",
    `- Platform: ${platform} (${os.release()})`,
    `- Node.js: ${nodeVersion}`,
    `- Host: ${hostname}`,
    effectiveSessionId ? `- Session: \`${effectiveSessionId}\`` : "",
    project_path ? `- Project: \`${project_path}\`` : "",
  ].filter(Boolean).join("\n");

  // Map category to GitHub label
  const categoryToLabel: Record<string, string> = {
    critical_problem: "critical",
    repeated_bug: "bug",
    one_time_bug: "bug",
    idea: "enhancement",
    must_have_feature: "enhancement",
  };
  const issueLabels = labels || [
    category ? (categoryToLabel[category] || "bug") : "bug",
    "from-ui",
  ];

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "claude-session-manager",
      },
      body: JSON.stringify({
        title: issueTitle,
        body: contextLines,
        labels: issueLabels,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      logAction("service", "create_failed", err, effectiveSessionId);
      return Response.json(
        { error: `GitHub API error: ${res.status} ${err.slice(0, 200)}` },
        { status: res.status }
      );
    }

    const issue = await res.json();
    logAction("service", "created", `#${issue.number}: ${issueTitle}`, effectiveSessionId);
    return Response.json({
      ok: true,
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAction("service", "create_error", msg, effectiveSessionId);
    return Response.json({ error: msg }, { status: 500 });
  }
}
