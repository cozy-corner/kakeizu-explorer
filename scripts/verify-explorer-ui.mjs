// Manual E2E smoke (not in the test suite — run by hand against a running dev
// server). Confirms the cytoscape ego graph renders, node-click re-centering
// works, and the Wikipedia pane loads.
//
// Run: BASE=http://localhost:3001 node scripts/verify-explorer-ui.mjs
// Requires playwright on the module path and a Chrome/Chromium channel.

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

  // Right pane: the focus person's ja.wikipedia article, embedded as an iframe.
  const articleFrame = page.locator("section").last().locator("iframe");
  await articleFrame.waitFor();
  const src = (await articleFrame.getAttribute("src")) ?? "";
  if (!src.startsWith("https://ja.wikipedia.org/wiki/"))
    fail(`article iframe src unexpected: ${src}`);
  else if (!decodeURIComponent(src).includes("織田信長"))
    fail(`article iframe not pointing at 織田信長: ${src}`);
  // Confirm the article actually rendered inside the cross-origin frame.
  await page
    .frameLocator("section iframe")
    .locator("#firstHeading")
    .waitFor({ timeout: 15000 });
  console.log("article iframe OK:", src);

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("screenshot:", SHOT);

  // Re-center: click a neighbour node → focus should switch to it.
  if (!before.other) throw new Error("no neighbour node to click");
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

  if (!process.exitCode) console.log("\nPASS: all UI checks");
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
