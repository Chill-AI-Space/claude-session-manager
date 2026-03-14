/**
 * POST /api/debug/ping — round-trip test for the debug log pipeline.
 *
 * 1. Sends a test log entry to the remote debug_log_endpoint
 * 2. Verifies it was stored by querying back
 * 3. Returns timing + status
 *
 * Usage:  curl -X POST http://localhost:3000/api/debug/ping
 * Deploy: add as step 7 in health checks
 */
import os from "os";
import { getSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  const endpoint = getSetting("debug_log_endpoint");
  if (!endpoint) {
    return Response.json({
      ok: false,
      status: "skipped",
      reason: "debug_log_endpoint not configured",
    });
  }

  const pingId = `ping-${Date.now()}`;
  const instance = `${os.hostname()}-${process.platform}-${process.pid}`;
  const entry = {
    ts: new Date().toISOString(),
    level: "info",
    source: "deploy-ping",
    message: pingId,
    data: { type: "health-check", hostname: os.hostname(), platform: process.platform, nodeVersion: process.version },
  };

  const t0 = Date.now();

  // Step 1: POST test entry
  try {
    const pushRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance, entries: [entry] }),
      signal: AbortSignal.timeout(5000),
    });

    if (!pushRes.ok) {
      const body = await pushRes.text();
      return Response.json({
        ok: false,
        status: "push_failed",
        httpCode: pushRes.status,
        error: body.slice(0, 200),
        pushMs: Date.now() - t0,
      });
    }
  } catch (err) {
    return Response.json({
      ok: false,
      status: "push_error",
      error: err instanceof Error ? err.message : String(err),
      pushMs: Date.now() - t0,
    });
  }

  const pushMs = Date.now() - t0;

  // Step 2: Verify by querying back
  try {
    const verifyRes = await fetch(
      `${endpoint}?source=deploy-ping&instance=${encodeURIComponent(instance)}&limit=1`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!verifyRes.ok) {
      return Response.json({
        ok: false,
        status: "verify_failed",
        pushMs,
        verifyMs: Date.now() - t0 - pushMs,
      });
    }

    const data = await verifyRes.json() as { logs: Array<{ message: string }> };
    const found = data.logs?.some((l) => l.message === pingId);

    return Response.json({
      ok: found,
      status: found ? "ok" : "not_found",
      pingId,
      instance,
      pushMs,
      verifyMs: Date.now() - t0 - pushMs,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    return Response.json({
      ok: false,
      status: "verify_error",
      error: err instanceof Error ? err.message : String(err),
      pushMs,
      totalMs: Date.now() - t0,
    });
  }
}
