#!/usr/bin/env node
// ============================================================
// StudyBuddy AI — browser end-to-end test.
//
// Drives the live demo through every tab (Dashboard, Doubt Solver,
// Planner, Quiz Arena, Notes) in a real Chromium browser and fails
// on any console/page error.
//
// Requirements:
//   npm i -D playwright-core
//   a Chromium-based browser (set CHROME_PATH if not auto-detected)
//
// Run the server first, then:  npm run ui:smoke
// ============================================================

import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/brave",
  "/snap/brave/713/opt/brave.com/brave/brave",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error(
    "No Chromium-based browser found. Set CHROME_PATH to a Chrome/Chromium/Brave binary."
  );
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});

let passed = 0;
let failed = 0;

const demo = () => page.locator("#demo");
const panel = () => page.getByRole("tabpanel");

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message.split("\n")[0]}`);
  }
}

async function openTab(name) {
  await demo().getByRole("tab", { name: new RegExp(name, "i") }).click();
  await page.waitForTimeout(900);
}

console.log(`\nStudyBuddy AI browser test → ${BASE}\n`);

try {
  await step("landing page loads", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
    if (!(await page.locator("body").innerText()).includes("StudyBuddy")) {
      throw new Error("brand missing");
    }
  });

  await step("demo dashboard shows live stats", async () => {
    await demo().scrollIntoViewIfNeeded();
    await demo().getByText("Weekly Activity").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1800); // let count-up animations finish
    const text = await panel().innerText();
    for (const label of [
      "Weekly Activity",
      "Weak-Topic Analytics",
      "Recent Quiz Attempts",
      "SYLLABUS MASTERY",
      "DBMS Exam",
    ]) {
      if (!text.includes(label)) throw new Error(`missing "${label}"`);
    }
    if (/\b0\s*days to go\b/i.test(text)) throw new Error("countdown still zero");
  });

  await step("doubt agent streams a cited answer", async () => {
    await openTab("Doubt Solver");
    await panel().getByText(/Ask anything from your syllabus/i).waitFor({ timeout: 20_000 });
    await panel().getByRole("button", { name: /Explain BCNF vs 3NF/i }).click();
    await page.waitForFunction(
      () => /·\s*p\.\d+/i.test(document.body.innerText),
      null,
      { timeout: 120_000 }
    );
    const text = await panel().innerText();
    if (!text.includes("BCNF")) throw new Error("answer missing BCNF");
  });

  await step("planner restores the saved plan", async () => {
    await openTab("Planner");
    await panel().getByText("Plan Parameters").waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => /DAY 1/.test(document.body.innerText), null, {
      timeout: 30_000,
    });
  });

  await step("planner generates a new plan", async () => {
    await panel().getByRole("button", { name: /Generate Adaptive Plan/i }).click();
    await page.getByText("Study plan ready", { exact: true }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(() => /DAY 3/.test(document.body.innerText), null, {
      timeout: 30_000,
    });
  });

  await step("quiz generates, grades and returns to dashboard", async () => {
    await openTab("Quiz Arena");
    await panel().getByRole("button", { name: /Generate & Start Quiz/i }).click();
    await panel().getByText(/Question 1 of \d+/).waitFor({ timeout: 120_000 });
    const total = Number(
      (await panel().getByText(/Question 1 of \d+/).innerText()).match(/of (\d+)/)[1]
    );

    for (let i = 1; i <= total; i += 1) {
      await panel()
        .getByText(new RegExp(`Question ${i} of ${total}`))
        .waitFor({ timeout: 30_000 });
      await panel().locator("button").filter({ hasText: /^A/ }).first().click();
      await panel()
        .getByRole("button", { name: i === total ? "See Results" : "Next Question" })
        .click();
      await page.waitForTimeout(350);
    }

    await panel().getByText(/final verdict/i).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    const text = await panel().innerText();
    if (!text.includes("Back to Dashboard")) throw new Error("back-to-dashboard missing");
    if (!/\d+\s*\/\s*\d+/.test(text)) throw new Error("score missing");

    await panel().getByRole("button", { name: /Back to Dashboard/i }).click();
    await demo().getByText("Weekly Activity").waitFor({ timeout: 30_000 });
  });

  await step("notes hub lists, adds and deletes a note", async () => {
    await openTab("Notes");
    await panel().getByText(/Notes Hub/i).first().waitFor({ timeout: 20_000 });
    const indexed = await panel().getByText(/RAG indexed/i).count();
    if (indexed < 4) throw new Error(`expected >=4 indexed notes, got ${indexed}`);

    await panel().getByRole("button", { name: /Add Note/i }).click();
    await page.locator("#note-title").fill("UI Smoke Note");
    await page.locator("#note-subject").fill("Testing");
    await page
      .locator("#note-content")
      .fill(
        "--- Page 1 --- Intro\nThis note verifies the add-note flow.\n--- Page 2 --- More\nAnd the delete flow."
      );
    await page.getByRole("button", { name: /Save & Index/i }).click();
    await panel().getByText("UI Smoke Note").waitFor({ timeout: 30_000 });

    await panel().locator('button[aria-label="Delete note: UI Smoke Note"]').click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(
      () => !document.body.innerText.includes("UI Smoke Note"),
      null,
      { timeout: 20_000 }
    );
  });
} finally {
  await browser.close();
}

if (errors.length) {
  failed += 1;
  console.error(`\n  ✗ browser console errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.error(`    - ${e}`);
} else {
  passed += 1;
  console.log("  ✓ no browser console errors");
}

// Leave the demo in a clean state: seed data + one 7-day plan.
try {
  await fetch(`${BASE}/api/demo/reset`, { method: "POST" });
  await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: "DBMS",
      days: 7,
      hoursPerDay: 3,
      weakTopics: "Normalization, BCNF decomposition",
    }),
  });
  console.log("\n  demo state reset to seed");
} catch {
  console.error("\n  could not reset demo state");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
