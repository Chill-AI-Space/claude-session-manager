#!/usr/bin/env node
// prebuild hook: `npm run build` on a machine with a live Session Manager overwrites .next under the running
// server, and the restart that follows kills its sessions. Non-blocking — just tells the human/agent the right command.
// Skipped when called from scripts/deploy-live.js (DEPLOY_LIVE=1) and in CI.

if (process.env.DEPLOY_LIVE === "1" || process.env.CI) process.exit(0);

const base = `http://localhost:${process.env.PORT || "3000"}`;

(async () => {
  try {
    const res = await fetch(`${base}/api/sessions?limit=500&include_remote=false`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const { sessions } = await res.json();
    const active = (sessions || []).filter((s) => s.is_active).length;
    console.warn(
      [
        "",
        "┌──────────────────────────────────────────────────────────────────────────┐",
        `  ⚠  A live Session Manager is running on :${process.env.PORT || "3000"} with ${active} active session(s).`,
        "  Building over it and restarting by hand will KILL those sessions.",
        "  To deploy, use:   npm run deploy:live   (rebuild + restart + auto-resume)",
        "  See README.md → \"Deploying\". (Just want a build to check? Ignore this.)",
        "└──────────────────────────────────────────────────────────────────────────┘",
        "",
      ].join("\n")
    );
  } catch {
    // no server running — nothing to warn about
  }
})();
