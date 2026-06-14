// Disposable spike experiment (PR2): seed-and-traverse instead of nationality
// filtering. Start from the RELAXED graph (Japanese seeds + their 1-hop
// relatives) and expand the NON-Japanese frontier outward, pulling in family
// relations regardless of nationality — the model proposed after we found the
// P27 filter severs real lineages (信長's paternal line: 11/13 ancestors have
// ja articles but only 1 has P27).
//
// Each round logs: nodes added, ja-article ratio of the new nodes (a proxy for
// "is this still Japanese lineage, or leaking into world royalty?"), total size.
//
// Run: ROUNDS=1 bun run scripts/etl-spike/traverse.ts   (then load.ts / verify.ts)

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sparql } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const ROUNDS = Number(process.env.ROUNDS ?? "1");
const EDGE_BATCH = 120;
const META_BATCH = 400;
const SIZE_CAP = 200_000;

const qid = (uri: string) => uri.replace("http://www.wikidata.org/entity/", "");
const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const values = (qids: string[]) => qids.map((q) => `wd:${q}`).join(" ");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")) as T;
}

// Members of `qids` that satisfy EXISTS{ pattern } — used for P27 and ja sweeps.
async function existsSweep(
  qids: string[],
  pattern: string,
): Promise<Set<string>> {
  const hit = new Set<string>();
  for (const b of chunk(qids, META_BATCH)) {
    const rows = await sparql(
      `SELECT ?item WHERE { VALUES ?item { ${values(b)} } ${pattern} }`,
    );
    for (const r of rows) hit.add(qid(r.item!.value));
  }
  return hit;
}

async function fetchLabels(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const b of chunk(qids, META_BATCH)) {
    const rows = await sparql(
      `SELECT ?item ?itemLabel WHERE { VALUES ?item { ${values(b)} }
       SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". } }`,
    );
    for (const r of rows) out.set(qid(r.item!.value), r.itemLabel?.value ?? "");
  }
  return out;
}

async function main() {
  const nodeRows =
    await readJson<{ qid: string; label: string }[]>("nodes.json");
  const parent =
    await readJson<{ from: string; to: string }[]>("parent_of.json");
  const spouse = await readJson<{ a: string; b: string }[]>("spouse_of.json");
  const sibling = await readJson<{ a: string; b: string }[]>("sibling_of.json");

  const labels = new Map(nodeRows.map((n) => [n.qid, n.label]));
  const known = new Set(labels.keys());
  const parentSet = new Set(parent.map((e) => `${e.from}->${e.to}`));
  const spouseSet = new Set(spouse.map((e) => `${e.a}|${e.b}`));
  const siblingSet = new Set(sibling.map((e) => `${e.a}|${e.b}`));

  const addParent = (from: string, to: string) => {
    if (from !== to) parentSet.add(`${from}->${to}`);
  };
  const addSym = (set: Set<string>, x: string, y: string) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    set.add(`${a}|${b}`);
  };

  // Frontier to expand = current non-Japanese nodes (JP seeds were already
  // fully expanded by the RELAXED fetch).
  console.log("Finding non-Japanese frontier (P27 sweep)…");
  const jp = await existsSweep([...known], "?item wdt:P27 wd:Q17.");
  let frontier = [...known].filter((q) => !jp.has(q));
  console.log(
    `  total ${known.size}, JP ${jp.size}, frontier(non-JP) ${frontier.length}`,
  );

  for (let round = 1; round <= ROUNDS && frontier.length > 0; round++) {
    const newNodes: string[] = [];
    const batches = chunk(frontier, EDGE_BATCH);
    for (let i = 0; i < batches.length; i++) {
      // Enumerate the 5 family predicates with VALUES ?p instead of a 5-way
      // UNION — far lighter for Blazegraph, which 504s on the UNION form.
      // ?p is the predicate URI (…/prop/direct/P22 etc.).
      const rows = await sparql(`
        SELECT ?s ?p ?o WHERE {
          VALUES ?s { ${values(batches[i])} }
          VALUES ?p { wdt:P22 wdt:P25 wdt:P40 wdt:P26 wdt:P3373 }
          ?s ?p ?o.
        }`);
      for (const r of rows) {
        const s = qid(r.s!.value);
        const o = qid(r.o!.value);
        // Skip "unknown value" snaks: they surface as genid blank-node IRIs,
        // not Q-ids, and would build an invalid `wd:<url>` VALUES downstream.
        if (!/^Q\d+$/.test(o)) continue;
        if (!known.has(o)) {
          known.add(o);
          newNodes.push(o);
        }
        const p = r.p!.value;
        if (p.endsWith("P22") || p.endsWith("P25"))
          addParent(o, s); // o is parent of s
        else if (p.endsWith("P40"))
          addParent(s, o); // o is child of s
        else if (p.endsWith("P26")) addSym(spouseSet, s, o);
        else addSym(siblingSet, s, o);
      }
      if ((i + 1) % 10 === 0)
        console.log(`    round ${round}: batch ${i + 1}/${batches.length}`);
      if (known.size > SIZE_CAP) break;
    }

    // Fill labels + measure ja-article ratio of the new nodes (leak proxy).
    const labelMap = await fetchLabels(newNodes);
    for (const [q, l] of labelMap) labels.set(q, l || q);
    const jaSet = await existsSweep(
      newNodes,
      "?art schema:about ?item; schema:isPartOf <https://ja.wikipedia.org/>.",
    );
    const ratio = newNodes.length
      ? ((jaSet.size / newNodes.length) * 100).toFixed(1)
      : "—";
    const sample = newNodes
      .slice(0, 6)
      .map((q) => labels.get(q))
      .join(", ");
    console.log(
      `Round ${round}: +${newNodes.length} nodes (ja ${ratio}%), total ${known.size}`,
    );
    console.log(`  sample new: ${sample}`);
    frontier = newNodes;
    if (known.size > SIZE_CAP) break;
  }

  const toParent = [...parentSet].map((k) => {
    const [from, to] = k.split("->");
    return { from, to };
  });
  const toSym = (set: Set<string>) =>
    [...set].map((k) => {
      const [a, b] = k.split("|");
      return { a, b };
    });
  await writeFile(
    join(DATA_DIR, "nodes.json"),
    JSON.stringify([...labels].map(([q, l]) => ({ qid: q, label: l }))),
  );
  await writeFile(join(DATA_DIR, "parent_of.json"), JSON.stringify(toParent));
  await writeFile(
    join(DATA_DIR, "spouse_of.json"),
    JSON.stringify(toSym(spouseSet)),
  );
  await writeFile(
    join(DATA_DIR, "sibling_of.json"),
    JSON.stringify(toSym(siblingSet)),
  );
  console.log(
    `Wrote: ${labels.size} nodes, ${parentSet.size} PARENT_OF, ${spouseSet.size} SPOUSE_OF, ${siblingSet.size} SIBLING_OF`,
  );
}

await main();
