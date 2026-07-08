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
// Extraction (issue #44): the frontier is decided LOCALLY from raw nationality
// (narrow rule: P27 ∋ Q17) — no P27 sweep. Newly discovered nodes/edges get their
// attributes captured once via attrs.ts, extending raw-*.json in the same shape
// fetch.ts wrote. Topology still comes from truthy `wdt:`.
//
// Run: ROUNDS=1 bun run scripts/etl-spike/traverse.ts   (then transform.ts …)

import { fetchNodeAttrs, fetchParentAndAdoptions } from "./attrs";
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

const ROUNDS = Number(process.env.ROUNDS ?? "1");
// Diagnostic (issue #16): cap the starting frontier to time a representative
// slice without a full cold run. 0 = no cap (normal behavior).
const FRONTIER_CAP = Number(process.env.FRONTIER_CAP ?? "0");
const EDGE_BATCH = 120;
const SIZE_CAP = 200_000;

// Wall-clock accounting per stage (issue #16, diagnostic): a cold run
// (WDQS_NOCACHE=1) reveals which stage dominates — the Amdahl fraction that
// bounds any parallelization win. Warm cache makes every stage instant, so the
// numbers only mean anything with the cache disabled. Never touches the output.
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

  // Frontier = current non-Japanese nodes (narrow rule, computed locally from raw
  // nationality — Japanese seeds were already fully expanded by the RELAXED fetch).
  const isJp = (q: string) =>
    (nodeById.get(q)?.nationalities ?? []).includes("Q17");
  let frontier = [...known].filter((q) => !isJp(q));
  if (FRONTIER_CAP > 0) frontier = frontier.slice(0, FRONTIER_CAP);
  console.log(
    `  total ${known.size}, JP ${known.size - frontier.length}, frontier(non-JP) ${frontier.length}`,
  );

  const allNewNodes: string[] = [];
  for (let round = 1; round <= ROUNDS && frontier.length > 0; round++) {
    const roundNewNodes: string[] = [];
    const batches = chunk(frontier, EDGE_BATCH);
    const tEdge = performance.now();
    // Fetch every batch concurrently (issue #16), fold in batch order so
    // aggregation stays deterministic. Enumerate the 5 family predicates with
    // VALUES ?p instead of a 5-way UNION — far lighter for Blazegraph, which
    // 504s on the UNION form.
    const rowsByBatch = await Promise.all(
      batches.map((b) =>
        sparql(`
        SELECT ?s ?p ?o WHERE {
          VALUES ?s { ${sparqlValues(b)} }
          VALUES ?p { wdt:P22 wdt:P25 wdt:P40 wdt:P26 wdt:P3373 }
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
        if (p.endsWith("P22") || p.endsWith("P25")) addParent(o, s);
        else if (p.endsWith("P40")) addParent(s, o);
        else if (p.endsWith("P26")) addSym(spouseKeys, rawSpouse, s, o);
        else addSym(siblingKeys, rawSibling, s, o);
      }
      if (known.size > SIZE_CAP) break;
    }
    addTiming("edge-loop", performance.now() - tEdge);

    // Capture attributes for the new nodes (label/sex/nationality) — needed both
    // for the next frontier's narrow rule and for local foreign-pruning later.
    const attrs = await timed("attrs", () => fetchNodeAttrs(roundNewNodes));
    for (const q of roundNewNodes) {
      nodeById.set(q, rawNodeOr(q, attrs));
      allNewNodes.push(q);
    }

    // ja-article ratio (leak proxy), now local instead of a WDQS sweep:
    // fetchNodeAttrs set wikipediaTitle from the same ja.wikipedia sitelink, and
    // every ja article carries a schema:name (verified), so `wikipediaTitle !==
    // undefined` ⟺ "has a ja article".
    const jaCount = roundNewNodes.filter(
      (q) => nodeById.get(q)?.wikipediaTitle !== undefined,
    ).length;
    const ratio = roundNewNodes.length
      ? ((jaCount / roundNewNodes.length) * 100).toFixed(1)
      : "—";
    const sample = roundNewNodes
      .slice(0, 6)
      .map((q) => nodeById.get(q)?.label)
      .join(", ");
    console.log(
      `Round ${round}: +${roundNewNodes.length} nodes (ja ${ratio}%), total ${known.size}`,
    );
    console.log(`  sample new: ${sample}`);
    frontier = roundNewNodes;
    if (known.size > SIZE_CAP) break;
  }

  // One reified sweep over the union of (a) all new nodes — so every new node's
  // adoptive statements are derived — and (b) both endpoints of the new parent
  // pairs — so parent-side (P40, on the possibly-old parent) rank is annotated.
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
