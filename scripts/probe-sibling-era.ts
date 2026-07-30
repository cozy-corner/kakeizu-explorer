// Probe: are the SIBLING_OF edges that are NOT recoverable via a shared PARENT_OF
// concentrated in modern people (芸能人 etc.) rather than the historical figures the
// app targets? Answers whether keeping SIBLING_OF in the path query buys real reach.
//
// Birth year lives only in Wikidata (the Neo4j Person node has no dates), so we ask
// WDQS with scoped VALUES batches. Run with the dev DB up:
//   bun run scripts/probe-sibling-era.ts
import { getDriver } from "../lib/neo4j";
import { chunk, qid, sparql, sparqlValues } from "./etl-spike/wdqs";

const BATCH = 300;

const SIBLING_ONLY_QIDS = `
MATCH (a:Person)-[:SIBLING_OF]->(b:Person)
WHERE NOT EXISTS { MATCH (p:Person)-[:PARENT_OF]->(a) WHERE (p)-[:PARENT_OF]->(b) }
WITH collect(a.qid) + collect(b.qid) AS qs
UNWIND qs AS q
RETURN DISTINCT q AS qid`;

// Baseline: the whole population, so the sibling-only set has something to be
// "more modern than". Every 12th qid in sorted order — deterministic across runs.
const BASELINE_QIDS = `
MATCH (p:Person)
WITH p ORDER BY p.qid
WITH collect(p.qid) AS qs
UNWIND range(0, size(qs) - 1, 12) AS i
RETURN qs[i] AS qid`;

async function fetchQids(query: string): Promise<string[]> {
  const res = await getDriver().executeQuery(query);
  return res.records.map((r) => r.get("qid") as string);
}

async function birthYears(qids: string[]): Promise<Map<string, number>> {
  const years = new Map<string, number>();
  for (const batch of chunk(qids, BATCH)) {
    // Raw date, not YEAR(): BCE and other odd literals make the aggregate come
    // back unbound, and a leading "-" needs handling anyway.
    const bindings = await sparql(`SELECT ?p ?birth WHERE {
      VALUES ?p { ${sparqlValues(batch)} }
      ?p wdt:P569 ?birth. }`);
    for (const b of bindings) {
      const birth = b.birth?.value;
      const p = b.p?.value;
      if (!birth || !p) continue;
      const m = /^(-?)(\d+)-/.exec(birth);
      if (!m) continue;
      const year = Number(m[2]) * (m[1] ? -1 : 1);
      // Multiple P569 values happen; keep the earliest so the bucket is stable.
      const prev = years.get(qid(p));
      if (prev === undefined || year < prev) years.set(qid(p), year);
    }
  }
  return years;
}

const BUCKETS: [string, (y: number) => boolean][] = [
  ["～1600 (中世・戦国以前)", (y) => y <= 1600],
  ["1601–1867 (江戸)", (y) => y > 1600 && y <= 1867],
  ["1868–1945 (明治〜戦前)", (y) => y > 1867 && y <= 1945],
  ["1946～ (戦後・現代)", (y) => y > 1945],
];

function report(name: string, qids: string[], years: Map<string, number>) {
  const counts = BUCKETS.map(() => 0);
  let unknown = 0;
  for (const q of qids) {
    const y = years.get(q);
    if (y === undefined) {
      unknown++;
      continue;
    }
    const idx = BUCKETS.findIndex(([, test]) => test(y));
    if (idx >= 0) counts[idx]++;
  }
  const known = qids.length - unknown;
  console.log(`\n=== ${name} (n=${qids.length}, 生年不明 ${unknown}) ===`);
  BUCKETS.forEach(([label], i) => {
    const pct = known ? ((counts[i] / known) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${label.padEnd(26)} ${String(counts[i]).padStart(5)}  ${pct}%`,
    );
  });
}

const siblingOnly = await fetchQids(SIBLING_ONLY_QIDS);
const baseline = await fetchQids(BASELINE_QIDS);
console.log(
  `sibling-only: ${siblingOnly.length}, baseline: ${baseline.length}`,
);

report(
  "SIBLING_OF only (共通の親なし)",
  siblingOnly,
  await birthYears(siblingOnly),
);
report("全人物からの標本", baseline, await birthYears(baseline));

await getDriver().close();
