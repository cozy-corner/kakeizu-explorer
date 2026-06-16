// Drive the running app in a real browser to capture the family-tree layout.
// Usage: node scripts/screenshot-graph.mjs <baseUrl> <query> <qid> <outPath> [pathQuery] [pathQid]
// With pathQuery+pathQid, also searches for a second person and clicks "⇄ 経路"
// to capture the shortest-path view.
import { chromium } from "playwright";

const [baseUrl, query, qid, outPath, pathQuery, pathQid] =
  process.argv.slice(2);
if (!baseUrl || !query || !qid || !outPath) {
  console.error(
    "args: <baseUrl> <query> <qid> <outPath> [pathQuery] [pathQid]",
  );
  process.exit(1);
}

// Use the system Chrome to avoid Playwright's pinned-browser download.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.getByLabel("人物名で検索").fill(query);
await page.getByRole("button", { name: "検索" }).click();
// Result rows render the qid; click the exact person.
await page.locator(`button:has-text("${qid}")`).first().click();
// cytoscape paints to a <canvas> inside the graph container; wait for it + layout.
await page.locator("canvas").first().waitFor({ state: "visible" });
await page.waitForTimeout(2500);

if (pathQuery && pathQid) {
  await page.getByLabel("人物名で検索").fill(pathQuery);
  await page.getByRole("button", { name: "検索" }).click();
  // The path button sits in the result row for the target person.
  const row = page.locator("li", { hasText: pathQid });
  await row.getByRole("button", { name: /経路/ }).click();
  await page.waitForTimeout(2500);
}
// Capture just the graph pane (first <section>) so the layout is legible.
await page.locator("section").first().screenshot({ path: outPath });

console.log("errors:", errors.length ? errors : "none");
await browser.close();
