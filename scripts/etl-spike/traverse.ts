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

import {
  annotateParentEdges,
  fetchAdoptiveEdges,
  fetchNodeAttrs,
} from "./attrs";
import {
  RAW_ADOPTIONS,
  RAW_NODES,
  RAW_PARENT,
  RAW_SIBLING,
  RAW_SPOUSE,
  type RawEdge,
  type RawNode,
  type RawPair,
  type RawParentEdge,
  readRaw,
  writeRaw,
} from "./raw";
import { chunk, qid, sparql, sparqlValues } from "./wdqs";

const ROUNDS = Number(process.env.ROUNDS ?? "1");
const EDGE_BATCH = 120;
const META_BATCH = 400;
const SIZE_CAP = 200_000;

// Diagnostic only (issue #44 exempts the ja.wikipedia leak proxy): which of
// `qids` have a ja.wikipedia article. Logged, never persisted.
async function jaSweep(qids: string[]): Promise<Set<string>> {
  const hit = new Set<string>();
  for (const b of chunk(qids, META_BATCH)) {
    const rows = await sparql(
      `SELECT ?item WHERE { VALUES ?item { ${sparqlValues(b)} }
       ?art schema:about ?item; schema:isPartOf <https://ja.wikipedia.org/>. }`,
    );
    for (const r of rows) hit.add(qid(r.item!.value));
  }
  return hit;
}

async function main() {
  const rawNodes = await readRaw<RawNode[]>(RAW_NODES);
  const rawParent = await readRaw<RawParentEdge[]>(RAW_PARENT);
  const rawSpouse = await readRaw<RawPair[]>(RAW_SPOUSE);
  const rawSibling = await readRaw<RawPair[]>(RAW_SIBLING);
  const rawAdoptions = await readRaw<RawEdge[]>(RAW_ADOPTIONS);

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
  console.log(
    `  total ${known.size}, JP ${known.size - frontier.length}, frontier(non-JP) ${frontier.length}`,
  );

  const allNewNodes: string[] = [];
  for (let round = 1; round <= ROUNDS && frontier.length > 0; round++) {
    const roundNewNodes: string[] = [];
    const batches = chunk(frontier, EDGE_BATCH);
    for (let i = 0; i < batches.length; i++) {
      // Enumerate the 5 family predicates with VALUES ?p instead of a 5-way
      // UNION — far lighter for Blazegraph, which 504s on the UNION form.
      const rows = await sparql(`
        SELECT ?s ?p ?o WHERE {
          VALUES ?s { ${sparqlValues(batches[i])} }
          VALUES ?p { wdt:P22 wdt:P25 wdt:P40 wdt:P26 wdt:P3373 }
          ?s ?p ?o.
        }`);
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
      if ((i + 1) % 10 === 0)
        console.log(`    round ${round}: batch ${i + 1}/${batches.length}`);
      if (known.size > SIZE_CAP) break;
    }

    // Capture attributes for the new nodes (label/sex/nationality) — needed both
    // for the next frontier's narrow rule and for local foreign-pruning later.
    const attrs = await fetchNodeAttrs(roundNewNodes);
    for (const q of roundNewNodes) {
      nodeById.set(
        q,
        attrs.get(q) ?? {
          qid: q,
          label: q,
          nationalities: [],
          nationalityCountries: [],
        },
      );
      allNewNodes.push(q);
    }

    const jaSet = await jaSweep(roundNewNodes);
    const ratio = roundNewNodes.length
      ? ((jaSet.size / roundNewNodes.length) * 100).toFixed(1)
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

  // Annotate the newly found parent edges with reified rank/P1039/P1480. Sweep
  // both endpoints so child-side (P22/P25) and parent-side (P40) statements are
  // both captured, matching how fetch.ts annotated its edges.
  const subjects = new Set<string>();
  for (const e of newParentPairs) {
    subjects.add(e.from);
    subjects.add(e.to);
  }
  const newRawParent = await annotateParentEdges(newParentPairs, [...subjects]);

  // Adoptive relations for the new nodes as subjects. fetch.ts already swept its
  // own nodes, so every final node is swept exactly once; merge + dedup.
  const adoptionKeys = new Set(rawAdoptions.map((e) => `${e.from}->${e.to}`));
  const newAdoptions: RawEdge[] = [];
  for (const e of await fetchAdoptiveEdges(allNewNodes)) {
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
}

await main();
