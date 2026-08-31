import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSetting } from "@/lib/db";
import { getOrchestrator } from "@/lib/orchestrator";

async function verifySignature(req: NextRequest, body: string): Promise<boolean> {
  const secret = getSetting("github_webhook_secret");
  if (!secret) return true; // no secret configured — accept all (dev mode)

  const sig = req.headers.get("x-hub-signature-256");
  if (!sig) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export async function POST(req: NextRequest) {
  const body = await req.text();

  if (!(await verifySignature(req, body))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const repo = payload.repository as Record<string, string> | undefined;
  const repoName = repo?.name ?? "";
  const repoFullName = repo?.full_name ?? repoName;

  if (event === "workflow_run") {
    const run = payload.workflow_run as Record<string, unknown> | undefined;
    if (!run || (payload.action !== "completed")) {
      return NextResponse.json({ ok: true, skipped: "not completed" });
    }
    if (run.conclusion !== "failure") {
      return NextResponse.json({ ok: true, skipped: "not failure" });
    }

    const orch = getOrchestrator();
    orch.enqueueCIFailureCheck({
      repoName,
      repoFullName,
      workflowName: String(run.name ?? ""),
      branch: String((run as Record<string, unknown>).head_branch ?? ""),
      runUrl: String(run.html_url ?? ""),
    });

    return NextResponse.json({ ok: true, queued: true, delay: "3min" });
  }

  if (event === "check_run") {
    const run = payload.check_run as Record<string, unknown> | undefined;
    if (!run || payload.action !== "completed") {
      return NextResponse.json({ ok: true, skipped: "not completed" });
    }
    if (run.conclusion !== "failure") {
      return NextResponse.json({ ok: true, skipped: "not failure" });
    }

    const orch = getOrchestrator();
    orch.enqueueCIFailureCheck({
      repoName,
      repoFullName,
      workflowName: String(run.name ?? ""),
      branch: String(((run as Record<string, unknown>).check_suite as Record<string, unknown>)?.head_branch ?? ""),
      runUrl: String(run.html_url ?? ""),
    });

    return NextResponse.json({ ok: true, queued: true, delay: "3min" });
  }

  return NextResponse.json({ ok: true, skipped: `unhandled event: ${event}` });
}
