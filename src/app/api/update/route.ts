import { NextRequest, NextResponse } from "next/server";
import { spawn, execSync } from "child_process";
import path from "path";
import os from "os";

const PROJECT_ROOT = path.resolve(process.cwd());

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function runStep(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    });
    let output = "";
    proc.stdout?.on("data", (d) => { output += d.toString(); });
    proc.stderr?.on("data", (d) => { output += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 1, output }));
    proc.on("error", (err) => resolve({ code: 1, output: err.message }));
  });
}

/** GET /api/update?check=1 — check if updates are available without applying */
/** POST /api/update — run the full update (SSE stream) */

export async function GET() {
  try {
    // Fetch latest from remote
    execSync("git fetch origin main", { cwd: PROJECT_ROOT, timeout: 15000, stdio: "pipe" });

    // Count commits behind
    const behind = execSync("git rev-list HEAD..origin/main --count", {
      cwd: PROJECT_ROOT,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    const count = parseInt(behind, 10) || 0;

    // Get current short hash
    const currentHash = execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_ROOT,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();

    // Get latest commit messages if updates available
    let commits: string[] = [];
    if (count > 0) {
      const log = execSync("git log HEAD..origin/main --oneline --no-decorate", {
        cwd: PROJECT_ROOT,
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      commits = log.split("\n").filter(Boolean);
    }

    return NextResponse.json({ updates_available: count > 0, count, currentHash, commits });
  } catch (err) {
    return NextResponse.json(
      { updates_available: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  // Optional: allow skipping install
  const body = await req.json().catch(() => ({}));
  const skipInstall = body.skipInstall === true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      }

      try {
        // Step 1: git pull
        send("step", { step: 1, total: 4, label: "Pulling latest code..." });
        const pull = await runStep("git", ["pull", "--ff-only", "origin", "main"], PROJECT_ROOT);
        if (pull.code !== 0) {
          send("error", { step: 1, message: "git pull failed", output: pull.output });
          controller.close();
          return;
        }
        const alreadyUpToDate = pull.output.includes("Already up to date");
        send("step_done", { step: 1, output: pull.output.trim().split("\n").slice(-2).join("\n") });

        if (alreadyUpToDate) {
          send("done", { message: "Already up to date", restarting: false });
          controller.close();
          return;
        }

        // Step 2: npm install (check if package.json or package-lock.json changed)
        if (!skipInstall) {
          send("step", { step: 2, total: 4, label: "Installing dependencies..." });
          const diffCheck = await runStep(
            "git",
            ["diff", "HEAD~1", "--name-only"],
            PROJECT_ROOT
          );
          const needsInstall =
            diffCheck.output.includes("package.json") ||
            diffCheck.output.includes("package-lock.json");

          if (needsInstall) {
            const install = await runStep("npm", ["install", "--prefer-offline"], PROJECT_ROOT);
            if (install.code !== 0) {
              send("error", { step: 2, message: "npm install failed", output: install.output.slice(-500) });
              controller.close();
              return;
            }
            send("step_done", { step: 2, output: "Dependencies installed" });
          } else {
            send("step_done", { step: 2, output: "Dependencies unchanged, skipped" });
          }
        } else {
          send("step_done", { step: 2, output: "Skipped (skipInstall)" });
        }

        // Step 3: Build
        send("step", { step: 3, total: 4, label: "Building..." });
        const build = await runStep("npm", ["run", "build"], PROJECT_ROOT);
        if (build.code !== 0) {
          send("error", { step: 3, message: "Build failed", output: build.output.slice(-1000) });
          controller.close();
          return;
        }
        send("step_done", { step: 3, output: "Build succeeded" });

        // Step 4: Restart server
        send("step", { step: 4, total: 4, label: "Restarting server..." });

        const platform = os.platform();
        if (platform === "darwin") {
          // macOS: restart via launchd (detached so the response completes)
          const plistPath = path.join(
            os.homedir(),
            "Library/LaunchAgents/com.vova.claude-sessions.plist"
          );
          // Spawn a detached shell that waits 1s then restarts launchd
          const restarter = spawn(
            "bash",
            [
              "-c",
              `sleep 1 && launchctl unload "${plistPath}" 2>/dev/null; sleep 1; launchctl load "${plistPath}"`,
            ],
            { detached: true, stdio: "ignore", cwd: PROJECT_ROOT }
          );
          restarter.unref();
          send("step_done", { step: 4, output: "Restart scheduled via launchd" });
        } else {
          // Linux/Windows: kill old next start, spawn new one
          const restarter = spawn(
            "bash",
            [
              "-c",
              `sleep 1 && pkill -f "next start" 2>/dev/null; sleep 1; cd "${PROJECT_ROOT}" && nohup npm run start > /dev/null 2>&1 &`,
            ],
            { detached: true, stdio: "ignore", cwd: PROJECT_ROOT }
          );
          restarter.unref();
          send("step_done", { step: 4, output: "Restart scheduled" });
        }

        send("done", { message: "Update complete", restarting: true });
      } catch (err) {
        send("error", { step: 0, message: (err as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
