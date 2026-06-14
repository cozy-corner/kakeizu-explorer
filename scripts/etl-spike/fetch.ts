// Disposable ETL spike (PR2): fetch real family relations from Wikidata and
// dump them to JSON. The goal is to validate data viability (connectivity +
// path quality), NOT production quality — see docs/specs/mvp-tasks.md (PR2).
//
// Run (strict, design-faithful population):  bun run scripts/etl-spike/fetch.ts
// Run (relaxed, include bridge relatives):   SPIKE_RELAX=1 bun run scripts/etl-spike/fetch.ts
//
// Two modes, to test the connectivity question:
//  - STRICT  (default): both endpoints of every edge are Japanese humans
//    (P31=Q5 ∧ P27=Q17). This matches the design's "JP population" core (§6).
//  - RELAXED (SPIKE_RELAX=1): at least one endpoint is a Japanese human; the
//    other may be any human. This pulls in non-JP-tagged relatives as bridge
//    nodes — a candidate fix if the strict graph turns out too fragmented.
//
// Scope (both modes, deliberately minimal): per node only { qid, label };
// birth/death/image and the birthplace rescue are deferred to PR6.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sparql } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const RELAX = process.env.SPIKE_RELAX === "1";

const LABEL_SERVICE =
  'SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }';

// Entity URI (http://www.wikidata.org/entity/Q123) → bare Q-id.
const qid = (uri: string) => uri.replace("http://www.wikidata.org/entity/", "");

const nodes = new Map<string, string>(); // qid → label
function remember(id: string, label: string | undefined) {
  if (!nodes.has(id)) nodes.set(id, label ?? id);
}

// Parent → child, normalized from P22 (father) / P25 (mother) / P40 (child).
async function fetchParentOf(): Promise<{ from: string; to: string }[]> {
  // STRICT: both endpoints JP. RELAXED: union of (child JP, any parent) and
  // (parent JP, any child) — each anchored on the JP node to stay under the
  // WDQS 60s timeout.
  const queries = RELAX
    ? [
        `SELECT ?p ?pLabel ?c ?cLabel WHERE {
           ?c wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
           ?p wdt:P31 wd:Q5. ${LABEL_SERVICE} }`,
        `SELECT ?p ?pLabel ?c ?cLabel WHERE {
           ?p wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
           ?c wdt:P31 wd:Q5. ${LABEL_SERVICE} }`,
      ]
    : [
        `SELECT ?p ?pLabel ?c ?cLabel WHERE {
           { ?c (wdt:P22|wdt:P25) ?p. } UNION { ?p wdt:P40 ?c. }
           ?c wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           ?p wdt:P31 wd:Q5; wdt:P27 wd:Q17. ${LABEL_SERVICE} }`,
      ];
  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const q of queries) {
    for (const b of await sparql(q)) {
      const from = qid(b.p!.value);
      const to = qid(b.c!.value);
      remember(from, b.pLabel?.value);
      remember(to, b.cLabel?.value);
      const key = `${from}->${to}`;
      if (from !== to && !seen.has(key)) {
        seen.add(key);
        edges.push({ from, to });
      }
    }
  }
  return edges;
}

// Symmetric relation (spouse / sibling): canonicalize the pair (sorted) so
// A-B and B-A collapse to one edge.
async function fetchSymmetric(
  property: string,
): Promise<{ a: string; b: string }[]> {
  const queries = RELAX
    ? [
        `SELECT ?a ?aLabel ?b ?bLabel WHERE {
           ?a wdt:P31 wd:Q5; wdt:P27 wd:Q17. ?a wdt:${property} ?b.
           ?b wdt:P31 wd:Q5. ${LABEL_SERVICE} }`,
        `SELECT ?a ?aLabel ?b ?bLabel WHERE {
           ?b wdt:P31 wd:Q5; wdt:P27 wd:Q17. ?a wdt:${property} ?b.
           ?a wdt:P31 wd:Q5. ${LABEL_SERVICE} }`,
      ]
    : [
        `SELECT ?a ?aLabel ?b ?bLabel WHERE {
           ?a wdt:${property} ?b.
           ?a wdt:P31 wd:Q5; wdt:P27 wd:Q17.
           ?b wdt:P31 wd:Q5; wdt:P27 wd:Q17. ${LABEL_SERVICE} }`,
      ];
  const seen = new Set<string>();
  const edges: { a: string; b: string }[] = [];
  for (const q of queries) {
    for (const r of await sparql(q)) {
      const x = qid(r.a!.value);
      const y = qid(r.b!.value);
      remember(x, r.aLabel?.value);
      remember(y, r.bLabel?.value);
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
  const parentOf = await fetchParentOf();
  console.log(`  PARENT_OF: ${parentOf.length}`);
  const spouseOf = await fetchSymmetric("P26");
  console.log(`  SPOUSE_OF: ${spouseOf.length}`);
  const siblingOf = await fetchSymmetric("P3373");
  console.log(`  SIBLING_OF: ${siblingOf.length}`);
  console.log(`  nodes (in some edge): ${nodes.size}`);

  await mkdir(DATA_DIR, { recursive: true });
  const nodeRows = [...nodes].map(([id, label]) => ({ qid: id, label }));
  await writeFile(join(DATA_DIR, "nodes.json"), JSON.stringify(nodeRows));
  await writeFile(join(DATA_DIR, "parent_of.json"), JSON.stringify(parentOf));
  await writeFile(join(DATA_DIR, "spouse_of.json"), JSON.stringify(spouseOf));
  await writeFile(join(DATA_DIR, "sibling_of.json"), JSON.stringify(siblingOf));
  console.log(`Wrote JSON to ${DATA_DIR}`);
}

await main();
