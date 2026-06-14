// Disposable spike diagnostic (PR2 follow-up): do the "bridge" relatives that
// RELAXED mode adds actually have ja.wikipedia articles? This matters for the
// right pane (Wikipedia view) when walking through them.
//
// For every loaded node we ask Wikidata two yes/no questions:
//   - P27=Q17?            → has Japanese nationality tag (core, not a bridge)
//   - has ja.wikipedia?   → right pane would show a real article
// Then we report ja-article coverage split by core vs. bridge (no P27 tag).
//
// Run: bun run scripts/etl-spike/check-wiki.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sparql } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const BATCH = 400;

async function main() {
  const nodes = JSON.parse(
    await readFile(join(DATA_DIR, "nodes.json"), "utf8"),
  ) as { qid: string; label: string }[];
  const labelOf = new Map(nodes.map((n) => [n.qid, n.label]));

  let coreTotal = 0;
  let coreWithJa = 0;
  let bridgeTotal = 0;
  let bridgeWithJa = 0;
  const bridgeWithoutJaSamples: string[] = [];

  for (let i = 0; i < nodes.length; i += BATCH) {
    const chunk = nodes.slice(i, i + BATCH);
    const values = chunk.map((n) => `wd:${n.qid}`).join(" ");
    const rows = await sparql(`
      SELECT ?item ?jp ?ja WHERE {
        VALUES ?item { ${values} }
        BIND(EXISTS { ?item wdt:P27 wd:Q17 } AS ?jp)
        BIND(EXISTS {
          ?art schema:about ?item; schema:isPartOf <https://ja.wikipedia.org/>
        } AS ?ja)
      }`);
    for (const r of rows) {
      const qid = r.item!.value.replace("http://www.wikidata.org/entity/", "");
      const isJp = r.jp!.value === "true";
      const hasJa = r.ja!.value === "true";
      if (isJp) {
        coreTotal++;
        if (hasJa) coreWithJa++;
      } else {
        bridgeTotal++;
        if (hasJa) bridgeWithJa++;
        else if (bridgeWithoutJaSamples.length < 8) {
          bridgeWithoutJaSamples.push(`${labelOf.get(qid) ?? qid} (${qid})`);
        }
      }
    }
    console.log(`  …${Math.min(i + BATCH, nodes.length)}/${nodes.length}`);
  }

  const pct = (a: number, b: number) =>
    b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`;
  console.log("\n== ja.wikipedia coverage ==");
  console.log(
    `  core (P27=日本):  ${coreWithJa}/${coreTotal} = ${pct(coreWithJa, coreTotal)}`,
  );
  console.log(
    `  bridge (P27なし): ${bridgeWithJa}/${bridgeTotal} = ${pct(bridgeWithJa, bridgeTotal)}`,
  );
  console.log("\n  sample bridge nodes WITHOUT a ja article:");
  for (const s of bridgeWithoutJaSamples) console.log(`    - ${s}`);
}

await main();
