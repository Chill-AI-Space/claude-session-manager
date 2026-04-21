#!/usr/bin/env node
/**
 * Browser smoke test — catches what curl-based tests miss:
 * - React hydration errors (#310)
 * - Infinite render loops (page hang)
 * - Empty sidebar despite working API
 * - Session content not loading
 * - JS bundle errors
 *
 * Usage: node scripts/browser-smoke-test.mjs [base_url]
 * Requires: npx playwright (chromium)
 */

import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:3000";
const TIMEOUT = 15_000;
let pass = 0;
let fail = 0;
const errors = [];

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
    fail++;
    errors.push(name);
  }
}

async function run() {
  console.log(`Browser smoke test: ${BASE}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Collect page crashes
  let pageCrashed = false;
  page.on("pageerror", () => { pageCrashed = true; });

  try {
    // ── 1. Main page loads ──
    console.log("1. Main page");
    await page.goto(`${BASE}/claude-sessions`, { timeout: TIMEOUT, waitUntil: "networkidle" });
    check("Page loads without timeout", true);

    // Wait for sessions to appear in sidebar
    await page.waitForTimeout(3000);

    const sidebarSessions = await page.evaluate(() => {
      return document.querySelectorAll('a[href*="/claude-sessions/"]').length;
    });
    check(`Sidebar has sessions (${sidebarSessions})`, sidebarSessions > 0);

    const reactErrors = consoleErrors.filter((e) => e.includes("Minified React error") || e.includes("Something went wrong"));
    check("No React errors", reactErrors.length === 0, reactErrors[0] || "");

    check("Page not crashed", !pageCrashed);

    // ── 2. Click into a session ──
    console.log("2. Session detail");
    const firstSessionHref = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/claude-sessions/"][href*="-"]');
      return link?.getAttribute("href") || "";
    });

    if (!firstSessionHref) {
      check("Found a session to click", false);
    } else {
      await page.goto(`${BASE}${firstSessionHref}`, { timeout: TIMEOUT, waitUntil: "networkidle" });
      check("Session page loads", true);

      // Wait for MD content
      await page.waitForTimeout(4000);

      const hasContent = await page.evaluate(() => {
        const body = document.body.innerText;
        return {
          hasMd: body.includes("User #") || body.includes("Claude #"),
          hasError: body.includes("Something went wrong"),
          hasLoading: body.includes("Loading session"),
          bodyLen: body.length,
        };
      });

      check(`MD content rendered (${hasContent.bodyLen} chars)`, hasContent.hasMd, hasContent.hasLoading ? "stuck on Loading..." : "");
      check("No error boundary", !hasContent.hasError);

      // Check page is responsive (not in infinite loop)
      const t0 = Date.now();
      await page.evaluate(() => document.title);
      const evalTime = Date.now() - t0;
      check(`Page responsive (${evalTime}ms eval)`, evalTime < 3000, evalTime >= 3000 ? "page may be in infinite loop" : "");

      // Check for new React errors after navigation
      const postNavErrors = consoleErrors.filter((e) => e.includes("Minified React error"));
      check("No React errors after navigation", postNavErrors.length === 0, postNavErrors[0] || "");
    }

    // ── 3. Summary/Learnings ──
    console.log("3. Summary & Learnings");
    const hasSummarySection = await page.evaluate(() => {
      const body = document.body.innerText;
      return body.includes("Summary") && body.includes("Learnings");
    });
    check("Summary/Learnings sections visible", hasSummarySection);

  } catch (e) {
    check("Test execution", false, e.message.slice(0, 200));
  } finally {
    await browser.close();
  }

  // ── Summary ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (fail === 0) {
    console.log(`✓ All ${pass} browser checks passed`);
  } else {
    console.log(`✗ ${fail} failed, ${pass} passed`);
    errors.forEach((e) => console.log(`  - ${e}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
