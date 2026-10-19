import { NextRequest } from "next/server";
import { getOpencodeBuilds, resolveOpencodeBuild } from "@/lib/opencode-builds";
import { findBuildManagerScript, installBuild, readBuildState, rollbackBuild, shiftBuild } from "@/lib/opencode-build-manager";
import { logAction } from "@/lib/db";

export const dynamic = "force-dynamic";

function catalog() {
  return getOpencodeBuilds().map((build) => {
    try {
      resolveOpencodeBuild(build.id);
      return { ...build, available: true };
    } catch (error) {
      return { ...build, available: false, error: String(error) };
    }
  });
}

export function GET() {
  try {
    return Response.json({
      builds: catalog(),
      manager: { available: Boolean(findBuildManagerScript()), script: findBuildManagerScript() },
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}

/** State is a nice-to-have in the response: never fail a successful action over it. */
function safeState() {
  try {
    return readBuildState();
  } catch {
    return null;
  }
}

/** Only these actions exist; the request never carries a command to run. */
const ACTIONS = new Set(["install", "shift", "rollback"]);

export async function POST(request: NextRequest) {
  let body: { action?: unknown; binary?: unknown; sha?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return Response.json({ error: `Unknown action: ${action || "(missing)"}. Expected install, shift or rollback` }, { status: 400 });
  }

  try {
    if (action === "install") {
      if (typeof body.binary !== "string" || !body.binary.trim()) throw new Error("install needs a binary path");
      const output = installBuild(body.binary.trim());
      logAction("settings", "install_opencode_build", body.binary.trim());
      return Response.json({ output, builds: catalog(), state: safeState() });
    }
    if (action === "shift") {
      if (typeof body.sha !== "string" || !body.sha.trim()) throw new Error("shift needs a build SHA");
      const output = shiftBuild(body.sha.trim());
      logAction("settings", "shift_opencode_build", body.sha.trim());
      return Response.json({ output, builds: catalog(), state: safeState() });
    }
    const output = rollbackBuild();
    logAction("settings", "rollback_opencode_build", "");
    return Response.json({ output, builds: catalog(), state: safeState() });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
