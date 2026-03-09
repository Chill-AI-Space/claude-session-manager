import { execSync } from "node:child_process";

export const dynamic = "force-dynamic";

export async function POST() {
  const log: string[] = [];

  try {
    // Step 1: Install globally
    log.push("$ npm i -g compress-on-input");
    try {
      const out = execSync("npm i -g compress-on-input 2>&1", {
        encoding: "utf-8",
        timeout: 60000,
      });
      log.push(out.trim());
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      log.push(err.stdout?.trim() || err.stderr?.trim() || "npm install failed");
      return Response.json({ ok: false, log: log.join("\n") });
    }

    // Step 2: Run install (adds hook to settings.json)
    log.push("\n$ compress-on-input install");
    try {
      const out = execSync("compress-on-input install 2>&1", {
        encoding: "utf-8",
        timeout: 10000,
      });
      log.push(out.trim());
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      log.push(err.stdout?.trim() || err.stderr?.trim() || "hook install failed");
      return Response.json({ ok: false, log: log.join("\n") });
    }

    // Step 3: Run check
    log.push("\n$ compress-on-input check");
    try {
      const out = execSync("compress-on-input check 2>&1", {
        encoding: "utf-8",
        timeout: 30000,
      });
      log.push(out.trim());
    } catch (e) {
      // check exits 1 on failures but still produces useful output
      const err = e as { stdout?: string; stderr?: string };
      log.push(err.stdout?.trim() || err.stderr?.trim() || "");
    }

    log.push("\nDone! Restart Claude Code for the hook to take effect.");
    return Response.json({ ok: true, log: log.join("\n") });
  } catch (e) {
    log.push(`Unexpected error: ${e}`);
    return Response.json({ ok: false, log: log.join("\n") });
  }
}
