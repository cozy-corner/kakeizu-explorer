// Probe: are the SIBLING_OF edges that are NOT recoverable via a shared PARENT_OF
// concentrated in modern people (芸能人 etc.) rather than the historical figures the
// app targets? Answers whether keeping SIBLING_OF in the path query buys real reach.
//
// Birth year lives only in Wikidata (the Neo4j Person node has no dates), so we ask
// WDQS with scoped VALUES batches. Run with the dev DB up:
//   bun run scripts/probe-sibling-era.ts
import neo4j from "neo4j-driver";

const WDQS = "https://query.wikidata.org/sparql";
const BATCH = 300;
const UA = "kakeizu-explorer-probe/1.0 (https://github.com/cozy-corner)";

const SIBLING_ONLY_QIDS = `
MATCH (a:Person)-[:SIBLING_OF]->(b:Person)
WHERE NOT EXISTS { MATCH (p:Person)-[:PARENT_OF]->(a) WHERE (p)-[:PARENT_OF]->(b) }
WITH collect(a.qid) + collect(b.qid) AS qs
UNWIND qs AS q
RETURN DISTINCT q AS qid`;

// Baseline: the whole population, so the sibling-only set has something to be
// "more modern than". Sampled by qid hash to stay deterministic across runs.
const BASELINE_QIDS = `
MATCH (p:Person)
WITH p ORDER BY p.qid
WITH collect(p.qid) AS qs
UNWIND range(0, size(qs) - 1, 12) AS i
RETURN qs[i] AS qid`;

async function fetchQids(query: string): Promise<string[]> {
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(
      process.env.NEO4J_USER ?? "neo4j",
      process.env.NEO4J_PASSWORD ?? "devpassword",
    ),
  );
  try {
    const res = await driver.executeQuery(query);
    return res.records.map((r) => r.get("qid") as string);
  } finally {
    await driver.close();
  }
}

async function birthYears(qids: string[]): Promise<Map<string, number>> {
  const years = new Map<string, number>();
  for (let i = 0; i < qids.length; i += BATCH) {
    const chunk = qids.slice(i, i + BATCH);
    const values = chunk.map((q) => `wd:${q}`).join(" ");
    // Raw date, not YEAR(): BCE and other odd literals make the aggregate come back
    // unbound, and a leading "-" needs handling anyway.
    const sparql = `SELECT ?p ?birth WHERE {
      VALUES ?p { ${values} }
      ?p wdt:P569 ?birth. }`;
    const res = await fetch(`${WDQS}?query=${encodeURIComponent(sparql)}`, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`WDQS ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      results: {
        bindings: { p?: { value: string }; birth?: { value: string } }[];
      };
    };
    for (const b of json.results.bindings) {
      if (!b.p?.value || !b.birth?.value) continue;
      const m = /^(-?)(\d{1,})-/.exec(b.birth.value);
      if (!m) continue;
      const year = Number(m[2]) * (m[1] ? -1 : 1);
      const qid = b.p.value.replace(/.*\//, "");
      // Multiple P569 values happen; keep the earliest so the bucket is stable.
      const prev = years.get(qid);
      if (prev === undefined || year < prev) years.set(qid, year);
    }
    console.log(`  ${Math.min(i + BATCH, qids.length)}/${qids.length}`);
    // WDQS rate-limits bursts; space the batches out.
    await new Promise((r) => setTimeout(r, 1200));
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

console.log("Fetching qids from Neo4j…");
const siblingOnly = await fetchQids(SIBLING_ONLY_QIDS);
const baseline = await fetchQids(BASELINE_QIDS);
console.log(
  `sibling-only: ${siblingOnly.length}, baseline: ${baseline.length}`,
);

console.log("Querying WDQS for sibling-only set…");
const siblingYears = await birthYears(siblingOnly);
console.log("Querying WDQS for baseline set…");
const baselineYears = await birthYears(baseline);

report("SIBLING_OF only (共通の親なし)", siblingOnly, siblingYears);
report("全人物からの標本", baseline, baselineYears);
