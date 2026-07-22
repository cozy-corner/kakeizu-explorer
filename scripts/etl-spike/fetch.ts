// Disposable ETL spike: fetch real family relations from Wikidata and dump them to
// raw-*.json. Goal is to validate data viability (connectivity + path quality), NOT
// production quality — see docs/specs/mvp-tasks.md.
//
// Run (strict, design-faithful population):  bun run scripts/etl-spike/fetch.ts
// Run (relaxed, include bridge relatives):   SPIKE_RELAX=1 bun run scripts/etl-spike/fetch.ts
//
// Two modes test the connectivity question:
//  - STRICT  (default): both endpoints of every edge are Japanese humans
//    (P31=Q5 ∧ P27=Q17), the design's "JP population" core (§6).
//  - RELAXED (SPIKE_RELAX=1): at least one endpoint is a Japanese human, the other
//    any human — pulls in non-JP-tagged bridge relatives if the strict graph is too
//    fragmented.
//
// Topology comes from truthy `wdt:` (decides which edges exist); every persisted
// attribute (label, sex, nationality, per-edge rank/P1039/P1480) is captured once via
// attrs.ts. The adoptive split and foreign pruning are pure-local transforms downstream.

import { fetchNodeAttrs, fetchParentAndAdoptions } from "./attrs";
import {
  RAW_ADOPTIONS,
  RAW_NODES,
  RAW_PARENT,
  RAW_SIBLING,
  RAW_SPOUSE,
  type RawNode,
  type RawPair,
  rawNodeOr,
  writeRaw,
} from "./raw";
import { qid, sparql } from "./wdqs";

const RELAX = process.env.SPIKE_RELAX === "1";

// Parent → child from P22 (father) / P25 (mother) / P40 (child). Truthy only; the
// adoptive split happens downstream in transform.ts over raw-adoptions.json.
async function fetchParentPairs(): Promise<{ from: string; to: string }[]> {
  const queries = RELAX
    ? [
        `SELECT ?p ?c WHERE {
           ?c wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
           ?p wdt:P31 wd:Q5. }`,
        `SELECT ?p ?c WHERE {
           ?p wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
           ?c wdt:P31 wd:Q5. }`,
      ]
    : [
        `SELECT ?p ?c WHERE {
           { ?c (wdt:P22|wdt:P25) ?p. } UNION { ?p wdt:P40 ?c. }
           ?c wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           ?p wdt:P31 wd:Q5; wdt:P27 wd:Q17. }`,
      ];
  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const q of queries) {
    for (const b of await sparql(q)) {
      const from = qid(b.p!.value);
      const to = qid(b.c!.value);
      const key = `${from}->${to}`;
      if (from !== to && !seen.has(key)) {
        seen.add(key);
        edges.push({ from, to });
      }
    }
  }
  return edges;
}

// Symmetric relation (spouse / sibling): sort each pair so A-B and B-A collapse to
// one edge. Truthy — rank/qualifiers not needed here.
async function fetchSymmetricPairs(property: string): Promise<RawPair[]> {
  const queries = RELAX
    ? [
        `SELECT ?a ?b WHERE {
           ?a wdt:P31 wd:Q5; wdt:P27 wd:Q17. ?a wdt:${property} ?b.
           ?b wdt:P31 wd:Q5. }`,
        `SELECT ?a ?b WHERE {
           ?b wdt:P31 wd:Q5; wdt:P27 wd:Q17. ?a wdt:${property} ?b.
           ?a wdt:P31 wd:Q5. }`,
      ]
    : [
        `SELECT ?a ?b WHERE {
           ?a wdt:${property} ?b.
           ?a wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           ?b wdt:P31 wd:Q5; wdt:P27 wd:Q17. }`,
      ];
  const seen = new Set<string>();
  const edges: RawPair[] = [];
  for (const q of queries) {
    for (const r of await sparql(q)) {
      const x = qid(r.a!.value);
      const y = qid(r.b!.value);
      if (x === y) continue;
      const [a, b] = x < y ? [x, y] : [y, x];
      const key = `${a}|${b}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ a, b });
      }
    }
  }
  return edges;
}

async function main() {
  console.log(
    `Fetching from Wikidata (WDQS) — mode: ${RELAX ? "RELAXED" : "STRICT"}`,
  );
  const parentPairs = await fetchParentPairs();
  console.log(`  PARENT_OF (truthy): ${parentPairs.length}`);
  const spouse = await fetchSymmetricPairs("P26");
  console.log(`  SPOUSE_OF: ${spouse.length}`);
  const sibling = await fetchSymmetricPairs("P3373");
  console.log(`  SIBLING_OF: ${sibling.length}`);

  const nodeIds = new Set<string>();
  for (const e of parentPairs) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  for (const e of spouse) {
    nodeIds.add(e.a);
    nodeIds.add(e.b);
  }
  for (const e of sibling) {
    nodeIds.add(e.a);
    nodeIds.add(e.b);
  }
  const ids = [...nodeIds];
  console.log(`  nodes (in some edge): ${ids.length}`);

  const attrs = await fetchNodeAttrs(ids);
  const rawNodes: RawNode[] = ids.map((q) => rawNodeOr(q, attrs));
  const { parent: rawParent, adoptions: rawAdoptions } =
    await fetchParentAndAdoptions(ids, parentPairs);
  console.log(`  adoptive relations: ${rawAdoptions.length}`);

  await writeRaw(RAW_NODES, rawNodes);
  await writeRaw(RAW_PARENT, rawParent);
  await writeRaw(RAW_SPOUSE, spouse);
  await writeRaw(RAW_SIBLING, sibling);
  await writeRaw(RAW_ADOPTIONS, rawAdoptions);
  console.log("Wrote raw-*.json");
}

await main();
