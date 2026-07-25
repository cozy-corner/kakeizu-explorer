// Disposable spike: seed-and-traverse instead of citizenship nationality filtering.
// Start from the RELAXED graph (Japanese seeds + 1-hop relatives) and expand the
// non-Japanese frontier outward, pulling in family regardless of nationality —
// the citizenship filter severs real lineages (信長's paternal line: 11/13 ancestors
// have ja articles but only 1 has a citizenship tag). Frontier decided locally from
// raw nationality; topology still from truthy `wdt:`.
//
// Foreign-pruning runs per round, not as one final pass: a round's new foreign
// nodes (broad rule: has a citizenship, none Japanese) are recorded but NOT carried
// into the next frontier, so they can't branch out into world genealogy. Untagged
// bridge relatives are kept (NOTES.md #2). A node reachable only through a foreign
// bridge would be severed by transform.ts's foreign-pruning anyway, so not expanding
// it loses no connected lineage. Traversal then self-converges (the frontier dries
// up) instead of leaning on SIZE_CAP; MAX_ROUNDS is only a safety ceiling.
//
// Run: bun run scripts/etl-spike/traverse.ts   (then transform.ts …)

import { fetchNodeAttrs, fetchParentAndAdoptions } from "./attrs";
import { CHILD, FATHER, MOTHER, SIBLING, SPOUSE } from "./properties";
import {
  RAW_ADOPTIONS,
  RAW_NODES,
  RAW_PARENT,
  RAW_SIBLING,
  RAW_SPOUSE,
  type RawAdoptiveEdge,
  type RawNode,
  type RawPair,
  type RawParentEdge,
  rawNodeOr,
  readRaw,
  writeRaw,
} from "./raw";
import { chunk, qid, sparql, sparqlValues } from "./wdqs";

// Safety ceiling only — the dynamic stop (foreign% ≥ ja%) or a dry frontier
// normally ends traversal first.
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? "8");
// Diagnostic: cap the starting frontier to time a representative slice without a
// full cold run.
const FRONTIER_CAP = Number(process.env.FRONTIER_CAP ?? "0");
const EDGE_BATCH = 120;
const SIZE_CAP = 200_000;

// Per-stage wall-clock, diagnostic only: meaningful just with WDQS_NOCACHE=1, since
// a warm cache makes every stage instant.
const timings = new Map<string, number>();
const addTiming = (stage: string, ms: number) =>
  timings.set(stage, (timings.get(stage) ?? 0) + ms);
async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    addTiming(stage, performance.now() - t0);
  }
}

async function main() {
  const rawNodes = await readRaw<RawNode[]>(RAW_NODES);
  const rawParent = await readRaw<RawParentEdge[]>(RAW_PARENT);
  const rawSpouse = await readRaw<RawPair[]>(RAW_SPOUSE);
  const rawSibling = await readRaw<RawPair[]>(RAW_SIBLING);
  const rawAdoptions = await readRaw<RawAdoptiveEdge[]>(RAW_ADOPTIONS);

  const nodeById = new Map(rawNodes.map((n) => [n.qid, n]));
  const known = new Set(nodeById.keys());
  const parentKeys = new Set(rawParent.map((e) => `${e.from}->${e.to}`));
  const spouseKeys = new Set(rawSpouse.map((e) => `${e.a}|${e.b}`));
  const siblingKeys = new Set(rawSibling.map((e) => `${e.a}|${e.b}`));

  const newParentPairs: { from: string; to: string }[] = [];
  const addParent = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}->${to}`;
    if (!parentKeys.has(key)) {
      parentKeys.add(key);
      newParentPairs.push({ from, to });
    }
  };
  const addSym = (set: Set<string>, list: RawPair[], x: string, y: string) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    if (!set.has(key)) {
      set.add(key);
      list.push({ a, b });
    }
  };

  // Initial frontier: non-Japanese nodes only (narrow rule) — the Japanese seeds
  // were already fully expanded by the upstream RELAXED fetch. This first hop still
  // steps through foreign nodes once; broad foreign-pruning kicks in from round 2.
  const isJp = (q: string) =>
    (nodeById.get(q)?.nationalities ?? []).includes("Q17");
  let frontier = [...known].filter((q) => !isJp(q));

  // Per-round pruning uses the same broad rule as transform.ts: foreign = has a
  // citizenship but none is Japanese (citizenship ∋ Q17, or a citizenship's country
  // ∋ Q17). Untagged bridge relatives (no citizenship) are kept.
  const isForeign = (q: string) => {
    const n = nodeById.get(q);
    if (!n || n.nationalities.length === 0) return false;
    return !(
      n.nationalities.includes("Q17") || n.nationalityCountries.includes("Q17")
    );
  };
  if (FRONTIER_CAP > 0) frontier = frontier.slice(0, FRONTIER_CAP);
  console.log(
    `  total ${known.size}, JP ${known.size - frontier.length}, frontier(non-JP) ${frontier.length}`,
  );

  const allNewNodes: string[] = [];
  for (let round = 1; round <= MAX_ROUNDS && frontier.length > 0; round++) {
    const roundNewNodes: string[] = [];
    const batches = chunk(frontier, EDGE_BATCH);
    const tEdge = performance.now();
    // Fold batches in order so aggregation stays deterministic. Enumerate the family
    // predicates with VALUES ?p instead of a 5-way UNION — Blazegraph 504s on UNION.
    const rowsByBatch = await Promise.all(
      batches.map((b) =>
        sparql(`
        SELECT ?s ?p ?o WHERE {
          VALUES ?s { ${sparqlValues(b)} }
          VALUES ?p { wdt:${FATHER} wdt:${MOTHER} wdt:${CHILD} wdt:${SPOUSE} wdt:${SIBLING} }
          ?s ?p ?o.
        }`),
      ),
    );
    for (const rows of rowsByBatch) {
      for (const r of rows) {
        const s = qid(r.s!.value);
        const o = qid(r.o!.value);
        // Skip "unknown value" snaks: they surface as genid blank-node IRIs.
        if (!/^Q\d+$/.test(o)) continue;
        if (!known.has(o)) {
          known.add(o);
          roundNewNodes.push(o);
        }
        const p = r.p!.value;
        if (p.endsWith(FATHER) || p.endsWith(MOTHER)) addParent(o, s);
        else if (p.endsWith(CHILD)) addParent(s, o);
        else if (p.endsWith(SPOUSE)) addSym(spouseKeys, rawSpouse, s, o);
        else addSym(siblingKeys, rawSibling, s, o);
      }
      if (known.size > SIZE_CAP) break;
    }
    addTiming("edge-loop", performance.now() - tEdge);

    // New nodes' attributes feed both this round's foreign-pruning and, via broad
    // citizenship (nationalityCountries), transform.ts's final pass.
    const attrs = await timed("attrs", () => fetchNodeAttrs(roundNewNodes));
    for (const q of roundNewNodes) {
      nodeById.set(q, rawNodeOr(q, attrs));
      allNewNodes.push(q);
    }

    // ja-article ratio and foreign ratio, the leak proxies. Every ja article carries
    // a schema:name, from which fetchNodeAttrs set wikipediaTitle, so
    // `wikipediaTitle !== undefined` ⟺ "has a ja article".
    const jaCount = roundNewNodes.filter(
      (q) => nodeById.get(q)?.wikipediaTitle !== undefined,
    ).length;
    const foreignCount = roundNewNodes.filter(isForeign).length;
    const total = roundNewNodes.length;
    const jaPct = total ? (jaCount / total) * 100 : 0;
    const foreignPct = total ? (foreignCount / total) * 100 : 0;
    const pct = (x: number) => (total ? x.toFixed(1) : "—");
    const sample = roundNewNodes
      .slice(0, 6)
      .map((q) => nodeById.get(q)?.label)
      .join(", ");
    console.log(
      `Round ${round}: +${total} nodes (ja ${pct(jaPct)}%, foreign ${pct(foreignPct)}%), total ${known.size}`,
    );
    console.log(`  sample new: ${sample}`);
    // Per-round pruning: this round's foreign nodes stay in the raw output (transform
    // drops them) but are held out of the next frontier so they can't branch further.
    frontier = roundNewNodes.filter((q) => !isForeign(q));
    if (known.size > SIZE_CAP) break;
    // Dynamic stop: once a hop's foreign inflow catches its ja articles, deeper hops
    // only dilute. Under pruning this rarely fires (foreign% stays low) — the frontier
    // usually dries up first — so it's a backstop, not the primary exit.
    if (foreignPct >= jaPct) break;
  }

  // One reified sweep over both all new nodes (to derive their adoptive statements)
  // and both endpoints of the new parent pairs (to annotate parent-side CHILD rank,
  // which may sit on an already-known parent).
  const subjects = new Set<string>(allNewNodes);
  for (const e of newParentPairs) {
    subjects.add(e.from);
    subjects.add(e.to);
  }
  const { parent: newRawParent, adoptions: sweptAdoptions } = await timed(
    "final-sweep",
    () => fetchParentAndAdoptions([...subjects], newParentPairs),
  );

  // fetch.ts already swept its own nodes, so dedup against the existing set.
  const adoptionKeys = new Set(rawAdoptions.map((e) => `${e.from}->${e.to}`));
  const newAdoptions: RawAdoptiveEdge[] = [];
  for (const e of sweptAdoptions) {
    const key = `${e.from}->${e.to}`;
    if (adoptionKeys.has(key)) continue;
    adoptionKeys.add(key);
    newAdoptions.push(e);
  }

  await writeRaw(RAW_NODES, [...nodeById.values()]);
  await writeRaw(RAW_PARENT, [...rawParent, ...newRawParent]);
  await writeRaw(RAW_SPOUSE, rawSpouse);
  await writeRaw(RAW_SIBLING, rawSibling);
  await writeRaw(RAW_ADOPTIONS, [...rawAdoptions, ...newAdoptions]);
  console.log(
    `Wrote: ${nodeById.size} nodes, ${rawParent.length + newRawParent.length} PARENT_OF, ${rawSpouse.length} SPOUSE_OF, ${rawSibling.length} SIBLING_OF, ${rawAdoptions.length + newAdoptions.length} adoptive`,
  );

  const total = [...timings.values()].reduce((a, b) => a + b, 0);
  console.log("=== stage timings (cold run; run with WDQS_NOCACHE=1) ===");
  for (const [stage, ms] of [...timings].sort((a, b) => b[1] - a[1])) {
    const pct = total ? ((ms / total) * 100).toFixed(1) : "—";
    console.log(`  ${stage.padEnd(12)} ${(ms / 1000).toFixed(1)}s  ${pct}%`);
  }
}

await main();
