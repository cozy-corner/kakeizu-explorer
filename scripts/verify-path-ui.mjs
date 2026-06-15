// Manual E2E smoke for PR5 path mode (not in the test suite — run by hand
// against a running dev server). Confirms: focusing a person then hitting a
// search result's ⇄経路 button renders the shortest-path graph (both endpoints
// highlighted), shows the path banner, loads the destination's article, and
// that tapping a path node re-centers back to the ego graph.
//
// Run: BASE=http://localhost:3002 node scripts/verify-path-ui.mjs
// Requires playwright on the module path and a Chrome/Chromium channel.

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3001";
const SHOT = process.env.SHOT ?? "/tmp/pr5-path-shot.png";

// 信長 → 家康: a known 3-hop path (信長 -子- 徳姫 -婚姻- 松平信康 -子- 家康).
const FROM = { q: "Q171411", label: "織田信長" };
const TO = { q: "Q171977", label: "徳川家康" };

function readCy() {
  // Cytoscape registers itself on its container element as `_cyreg`.
  const el = [...document.querySelectorAll("div")].find(
    (d) => d._cyreg && d._cyreg.cy,
  );
  if (!el) return null;
  const cy = el._cyreg.cy;
  const bb = el.getBoundingClientRect();
  const labels = cy.nodes().map((n) => n.data("label"));
  const focusNode = cy.nodes("[focus = 1]")[0];
  const r = focusNode?.renderedPosition();
  return {
    nodeCount: cy.nodes().length,
    focusCount: cy.nodes("[focus = 1]").length,
    labels,
    // A highlighted endpoint to click for the re-center check.
    focus: focusNode
      ? { label: focusNode.data("label"), x: bb.x + r.x, y: bb.y + r.y }
      : null,
  };
}

const waitGraph = (page) =>
  page.waitForFunction(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d._cyreg && d._cyreg.cy,
    );
    return el && el._cyreg.cy.nodes().length > 0;
  });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

try {
  await page.goto(BASE, { waitUntil: "networkidle" });

  // Focus the "from" person via search.
  await page.getByLabel("人物名で検索").fill(FROM.label);
  await page.getByRole("button", { name: "検索" }).click();
  await page.locator("button", { hasText: FROM.q }).click();
  await page.waitForSelector("section canvas");
  await waitGraph(page);
  const ego = await page.evaluate(readCy);
  console.log(
    `ego graph: ${ego.nodeCount} nodes, focusCount=${ego.focusCount}`,
  );
  if (ego.focusCount !== 1)
    fail(`ego graph should have 1 focus node, got ${ego.focusCount}`);

  // Search the "to" person and hit its ⇄経路 button.
  await page.getByLabel("人物名で検索").fill(TO.label);
  await page.getByRole("button", { name: "検索" }).click();
  await page
    .locator("li", { hasText: TO.q })
    .getByRole("button", { name: "経路" })
    .click();

  // Path banner appears and the graph re-renders with BOTH endpoints highlighted.
  await page.waitForSelector("text=エゴ表示に戻る");
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d._cyreg && d._cyreg.cy,
    );
    return el && el._cyreg.cy.nodes("[focus = 1]").length === 2;
  });
  const path = await page.evaluate(readCy);
  console.log(
    `path graph: ${path.nodeCount} nodes [${path.labels.join(", ")}]`,
  );
  if (path.focusCount !== 2)
    fail(`path graph should highlight 2 endpoints, got ${path.focusCount}`);
  for (const want of [FROM.label, TO.label]) {
    if (!path.labels.includes(want)) fail(`path graph missing ${want}`);
  }

  // Right pane: the destination's article.
  await page.waitForSelector("text=Wikipedia で全文を読む");
  const article = await page.locator("section").last().innerText();
  if (!article.includes("徳川"))
    fail("article pane missing 徳川 (destination) content");
  console.log("article OK:", article.slice(0, 40).replace(/\n/g, " "));

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("screenshot:", SHOT);

  // 「エゴ表示に戻る」 leaves path mode → ego graph (single focus) of the start.
  await page.getByRole("button", { name: "エゴ表示に戻る" }).click();
  await page.waitForFunction(
    (label) => {
      const el = [...document.querySelectorAll("div")].find(
        (d) => d._cyreg && d._cyreg.cy,
      );
      const f = el?._cyreg.cy.nodes("[focus = 1]");
      return f && f.length === 1 && f[0].data("label") === label;
    },
    FROM.label,
    { timeout: 10000 },
  );
  if (await page.locator("text=エゴ表示に戻る").count())
    fail("path banner still shown after returning to ego");
  console.log("『エゴ表示に戻る』 → ego graph of", FROM.label);

  // Re-enter path mode (positions change after re-layout, so re-read coords).
  await page.getByLabel("人物名で検索").fill(TO.label);
  await page.getByRole("button", { name: "検索" }).click();
  await page
    .locator("li", { hasText: TO.q })
    .getByRole("button", { name: "経路" })
    .click();
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d._cyreg && d._cyreg.cy,
    );
    return el && el._cyreg.cy.nodes("[focus = 1]").length === 2;
  });
  const path2 = await page.evaluate(readCy);

  // Tapping a path node also leaves path mode → ego graph of that node.
  console.log("clicking path endpoint:", path2.focus.label);
  await page.mouse.click(path2.focus.x, path2.focus.y);
  await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll("div")].find(
        (d) => d._cyreg && d._cyreg.cy,
      );
      return el && el._cyreg.cy.nodes("[focus = 1]").length === 1;
    },
    null,
    { timeout: 10000 },
  );
  console.log("re-centered to ego graph (single focus)");

  if (!process.exitCode) console.log("\nPASS: all path-mode UI checks");
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
