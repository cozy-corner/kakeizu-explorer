// Manual E2E smoke for PR4 (not part of the test suite — run by hand against a
// running dev server). Drives a real browser to confirm the cytoscape ego graph
// renders, node-click re-centering works, and the Wikipedia pane loads.
//
// Run: BASE=http://localhost:3001 node scripts/verify-pr4.mjs
// Requires playwright available on the module path and a Chrome/Chromium channel.

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3001";
const SHOT = process.env.SHOT ?? "/tmp/pr4-shot.png";

function findCy() {
  // Cytoscape registers itself on its container element as `_cyreg`.
  const el = [...document.querySelectorAll("div")].find(
    (d) => d._cyreg && d._cyreg.cy,
  );
  if (!el) return null;
  const cy = el._cyreg.cy;
  const bb = el.getBoundingClientRect();
  const focus = cy.nodes("[focus = 1]")[0];
  const other = cy.nodes().filter((n) => n.data("focus") !== 1)[0];
  const r = other?.renderedPosition();
  return {
    nodeCount: cy.nodes().length,
    edgeCount: cy.edges().length,
    focusLabel: focus?.data("label") ?? null,
    other: other
      ? { label: other.data("label"), x: bb.x + r.x, y: bb.y + r.y }
      : null,
  };
}

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

try {
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Search → pick 織田信長 himself (Q171411; other results merely contain his name).
  await page.getByLabel("人物名で検索").fill("織田信長");
  await page.getByRole("button", { name: "検索" }).click();
  await page.locator("button", { hasText: "Q171411" }).click();

  // Cytoscape draws into <canvas>; wait for it, then read the live instance.
  await page.waitForSelector("section canvas");
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d._cyreg && d._cyreg.cy,
    );
    return el && el._cyreg.cy.nodes().length > 0;
  });

  const before = await page.evaluate(findCy);
  console.log(
    "graph:",
    before.nodeCount,
    "nodes /",
    before.edgeCount,
    "edges; focus =",
    before.focusLabel,
  );
  if (!before.nodeCount) fail("graph rendered no nodes");
  if (before.focusLabel !== "織田信長")
    fail(`focus node label was ${before.focusLabel}`);

  // Right pane: ja.wikipedia summary for the focus person.
  await page.waitForSelector("text=Wikipedia で全文を読む");
  const articleText = await page.locator("section").last().innerText();
  if (!articleText.includes("織田")) fail("article pane missing 織田 content");
  console.log("article OK:", articleText.slice(0, 40).replace(/\n/g, " "));

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("screenshot:", SHOT);

  // Re-center: click a neighbour node → focus should switch to it.
  if (!before.other) fail("no neighbour node to click");
  console.log("clicking neighbour:", before.other.label);
  await page.mouse.click(before.other.x, before.other.y);
  await page.waitForFunction(
    (prev) => {
      const el = [...document.querySelectorAll("div")].find(
        (d) => d._cyreg && d._cyreg.cy,
      );
      const f = el?._cyreg.cy.nodes("[focus = 1]")[0];
      return f && f.data("label") !== prev;
    },
    before.focusLabel,
    { timeout: 10000 },
  );
  const after = await page.evaluate(findCy);
  console.log("re-centered focus =", after.focusLabel);
  if (after.focusLabel === before.focusLabel)
    fail("focus did not change after node click");

  if (!process.exitCode) console.log("\nPASS: all PR4 UI checks");
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
