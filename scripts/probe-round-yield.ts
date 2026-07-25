// Non-destructive probe: estimate how many NEW people each further traversal hop
// would add beyond the current graph, and the QUALITY of what it adds.
//
// Starts from the current graph node set and expands ONE family hop at a time
// (truthy P22/P25/P40/P26/P3373, same as traverse.ts). Each hop's frontier is the
// previous hop's NEW nodes — so hop1 ≈ ROUNDS=2, hop2 ≈ ROUNDS=3, etc. Reports per
// hop: new-node count, ja-article rate, and foreign-pruning survival. Like
// traverse, it does NOT prune between hops, so rising foreign% across hops is the
// world-genealogy leak (NOTES.md #3) showing up.
//
// hop1 reuses the same 120-node batches as the seed-1 full run, so it hits the
// WDQS cache; only hop2+ are cold. Writes nothing.
//
// Usage: bun run scripts/probe-round-yield.ts [--hops N] [--seed S]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchNodeAttrs } from "./etl-spike/attrs";
import { CHILD, FATHER, MOTHER, SIBLING, SPOUSE } from "./etl-spike/properties";
import { chunk, qid, sparql, sparqlValues } from "./etl-spike/wdqs";

const DATA = join(import.meta.dirname, "etl-spike", "data");
const args = process.argv.slice(2);
const flag = (n: string, d: number) => {
  const i = args.indexOf(n);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const HOPS = flag("--hops", 2);
const SEED = flag("--seed", 1);
// With --prune, a hop's new foreign nodes ("has a nationality, none Japanese") are
// still counted but NOT carried into the next frontier — so they can't branch out
// into world genealogy. Untagged (no nationality) bridge relatives are kept, per
// NOTES.md #2. Mimics moving foreign-pruning from one final pass into the loop.
const PRUNE = args.includes("--prune");

const nodes = JSON.parse(await readFile(join(DATA, "nodes.json"), "utf8")) as {
  qid: string;
  label: string;
}[];

// Shuffle identically to the seed-1 full run so hop1's batches — hence its query
// strings — match the cache.
function shuffled(qids: string[], seed: number): string[] {
  let s = seed >>> 0;
  const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const a = [...qids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One family hop from `frontier`: every truthy family neighbor, as Q-ids.
async function expand(frontier: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    chunk(frontier, 120).map(async (b) => {
      const rows = await sparql(`
      SELECT ?s ?p ?o WHERE {
        VALUES ?s { ${sparqlValues(b)} }
        VALUES ?p { wdt:${FATHER} wdt:${MOTHER} wdt:${CHILD} wdt:${SPOUSE} wdt:${SIBLING} }
        ?s ?p ?o.
      }`);
      for (const r of rows) {
        const o = qid(r.o!.value);
        if (/^Q\d+$/.test(o)) out.add(o);
      }
    }),
  );
  return out;
}

const known = new Set(nodes.map((n) => n.qid));
// hop1 expands the whole current graph (matches the seed-1 full run / cache).
let frontier = shuffled([...known], SEED);

console.log(`current graph: ${known.size} nodes\n`);
for (let hop = 1; hop <= HOPS; hop++) {
  const neighbors = await expand(frontier);
  const newNodes = [...neighbors].filter((q) => !known.has(q));

  const attrs = await fetchNodeAttrs(newNodes);
  const isJapanBroad = (q: string) => {
    const n = attrs.get(q);
    return (
      !!n &&
      (n.nationalities.includes("Q17") ||
        n.nationalityCountries.includes("Q17"))
    );
  };
  const hasNat = (q: string) => (attrs.get(q)?.nationalities.length ?? 0) > 0;
  const withJa = newNodes.filter((q) => attrs.get(q)?.wikipediaTitle).length;
  const foreign = newNodes.filter((q) => hasNat(q) && !isJapanBroad(q)).length;
  const keepable = newNodes.length - foreign;
  const pct = (x: number) =>
    newNodes.length ? ((x / newNodes.length) * 100).toFixed(1) : "0.0";

  console.log(
    `hop${hop} (≈ROUNDS=${hop + 1}): frontier ${frontier.length} → ${newNodes.length} new  ` +
      `[ja ${pct(withJa)}%, foreign ${pct(foreign)}%, keepable ${keepable}]`,
  );

  // Next hop expands this hop's new nodes; under --prune, drop foreign ones so
  // they can't seed further foreign branches.
  for (const q of newNodes) known.add(q);
  frontier = PRUNE
    ? newNodes.filter((q) => !(hasNat(q) && !isJapanBroad(q)))
    : newNodes;
  if (newNodes.length === 0) {
    console.log("  (dry — stopping)");
    break;
  }
}
console.log(`\ncumulative reachable after ${HOPS} hop(s): ${known.size} nodes`);
