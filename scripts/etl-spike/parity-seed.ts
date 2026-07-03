// Parity guard for the #44 extract-unification refactor. Behavior-preserving is
// the whole claim, so prove it mechanically instead of by eye: on a small seed
// neighborhood, compute the load inputs the NEW way (raw capture + local
// transform) and the OLD way (the pre-#44 WDQS queries, inlined here), then diff
// the node / spine / adopted / sex sets. Seed-scoped so it stays cheap and
// cache-friendly — it does NOT run the full population pipeline.
//
// Run: bun run scripts/etl-spike/parity-seed.ts
//
// The one intended difference (traverse-discovered adoptions no longer leaking
// into the spine) cannot appear here: this check is fetch-shaped (no frontier
// expansion), where old and new both drop adoptions from the spine.

import {
  annotateParentEdges,
  fetchAdoptiveEdges,
  fetchNodeAttrs,
} from "./attrs";
import { KINSHIP, PARENT_ROLE } from "./adoption-roles";
import type { RawNode } from "./raw";
import { qid, sparql, sparqlValues } from "./wdqs";

// Seeds chosen to exercise the risky paths: disputed/deprecated fathers
// (光秀), Tokugawa adoption (吉宗), plus plain lineages for breadth.
const SEEDS = [
  "Q313320", // 明智光秀
  "Q319664", // 徳川吉宗
  "Q171411", // 織田信長
  "Q171977", // 徳川家康
];

const KV = sparqlValues(KINSHIP);

// Seed + 1-hop family neighborhood (bounded), the node set both paths run over.
async function neighborhood(): Promise<string[]> {
  const nodes = new Set(SEEDS);
  const rows = await sparql(`
    SELECT ?o WHERE {
      VALUES ?s { ${sparqlValues(SEEDS)} }
      VALUES ?p { wdt:P22 wdt:P25 wdt:P40 wdt:P26 wdt:P3373 }
      { ?s ?p ?o. } UNION { ?o ?p ?s. }
    }`);
  for (const r of rows) {
    const o = qid(r.o!.value);
    if (/^Q\d+$/.test(o)) nodes.add(o);
  }
  return [...nodes];
}

// ---- OLD path: the pre-#44 queries, scoped to the node set N. ----

async function oldSpine(ids: string[]): Promise<Set<string>> {
  // truthy P22/P25/P40 among N, with the old EXCLUDE_ADOPTIVE reified subquery.
  const excludeAdoptive = `FILTER NOT EXISTS {
    VALUES ?k { ${KV} }
    { ?c p:P22 ?st. ?st ps:P22 ?p. ?st pq:P1039 ?k. }
    UNION { ?c p:P25 ?st. ?st ps:P25 ?p. ?st pq:P1039 ?k. }
    UNION { ?p p:P40 ?st. ?st ps:P40 ?c. ?st pq:P1039 ?k. }
    ?st wikibase:rank ?rank. FILTER(?rank != wikibase:DeprecatedRank) }`;
  const rows = await sparql(`
    SELECT ?p ?c WHERE {
      VALUES ?p { ${sparqlValues(ids)} } VALUES ?c { ${sparqlValues(ids)} }
      { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
      ${excludeAdoptive} }`);
  const out = new Set<string>();
  for (const r of rows) {
    const p = qid(r.p!.value);
    const c = qid(r.c!.value);
    if (p !== c) out.add(`${p}->${c}`);
  }
  return out;
}

async function oldAdopted(ids: string[]): Promise<Set<string>> {
  const known = new Set(ids);
  const rows = await sparql(`
    SELECT ?s ?o ?k WHERE {
      VALUES ?s { ${sparqlValues(ids)} } VALUES ?k { ${KV} }
      { { ?s p:P1038 ?st. ?st ps:P1038 ?o. }
        UNION { ?s p:P22 ?st. ?st ps:P22 ?o. }
        UNION { ?s p:P25 ?st. ?st ps:P25 ?o. }
        UNION { ?s p:P40 ?st. ?st ps:P40 ?o. } }
      ?st pq:P1039 ?k. ?st wikibase:rank ?rank.
      FILTER(?rank != wikibase:DeprecatedRank) }`);
  const out = new Set<string>();
  for (const r of rows) {
    const s = qid(r.s!.value);
    const o = qid(r.o!.value);
    const k = qid(r.k!.value);
    if (s === o || !known.has(o)) continue;
    const [from, to] = PARENT_ROLE.has(k) ? [o, s] : [s, o];
    out.add(`${from}->${to}`);
  }
  return out;
}

async function oldForeign(ids: string[]): Promise<Set<string>> {
  const sweep = async (pattern: string) => {
    const hit = new Set<string>();
    const rows = await sparql(
      `SELECT ?item WHERE { VALUES ?item { ${sparqlValues(ids)} } ${pattern} }`,
    );
    for (const r of rows) hit.add(qid(r.item!.value));
    return hit;
  };
  const jpNat = await sweep(
    "{ ?item wdt:P27 wd:Q17. } UNION { ?item wdt:P27/wdt:P17 wd:Q17. }",
  );
  const anyNat = await sweep("?item wdt:P27 [].");
  return new Set(ids.filter((q) => anyNat.has(q) && !jpNat.has(q)));
}

async function oldSex(ids: string[]): Promise<Map<string, string>> {
  const SEX: Record<string, string> = { Q6581097: "male", Q6581072: "female" };
  const rows = await sparql(
    `SELECT ?p ?sex WHERE { VALUES ?p { ${sparqlValues(ids)} } ?p wdt:P21 ?sex. }`,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    const p = qid(r.p!.value);
    if (!out.has(p)) out.set(p, SEX[qid(r.sex!.value)] ?? "other");
  }
  return out;
}

// ---- NEW path: raw capture (attrs.ts) + transform.ts logic, scoped to N. ----

async function newTruthyPairs(
  ids: string[],
): Promise<{ from: string; to: string }[]> {
  const rows = await sparql(`
    SELECT ?p ?c WHERE {
      VALUES ?p { ${sparqlValues(ids)} } VALUES ?c { ${sparqlValues(ids)} }
      { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c } }`);
  const out: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const from = qid(r.p!.value);
    const to = qid(r.c!.value);
    const key = `${from}->${to}`;
    if (from !== to && !seen.has(key)) {
      seen.add(key);
      out.push({ from, to });
    }
  }
  return out;
}

const JAPAN = "Q17";
const isForeign = (n: RawNode) =>
  n.nationalities.length > 0 &&
  !(n.nationalities.includes(JAPAN) || n.nationalityCountries.includes(JAPAN));

function diff(name: string, a: Set<string>, b: Set<string>): boolean {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`  ✅ ${name}: identical (${a.size})`);
    return true;
  }
  console.log(`  ❌ ${name}: old=${a.size} new=${b.size}`);
  if (onlyA.length)
    console.log(`     only OLD: ${onlyA.slice(0, 10).join(", ")}`);
  if (onlyB.length)
    console.log(`     only NEW: ${onlyB.slice(0, 10).join(", ")}`);
  return false;
}

async function main() {
  const ids = await neighborhood();
  console.log(`Seed neighborhood: ${ids.length} nodes\n`);

  // OLD
  const oForeign = await oldForeign(ids);
  const oKept = new Set(ids.filter((q) => !oForeign.has(q)));
  const keep2 = (kept: Set<string>, e: string) => {
    const [a, b] = e.split("->");
    return kept.has(a) && kept.has(b);
  };
  const oSpine = new Set(
    [...(await oldSpine(ids))].filter((e) => keep2(oKept, e)),
  );
  const oAdopted = new Set(
    [...(await oldAdopted(ids))].filter((e) => keep2(oKept, e)),
  );
  const oSex = await oldSex([...oKept]);

  // NEW
  const attrs = await fetchNodeAttrs(ids);
  const rawNodes = ids.map(
    (q) =>
      attrs.get(q) ?? {
        qid: q,
        label: q,
        nationalities: [],
        nationalityCountries: [],
      },
  );
  const nKept = new Set(
    rawNodes.filter((n) => !isForeign(n)).map((n) => n.qid),
  );
  const pairs = await newTruthyPairs(ids);
  await annotateParentEdges(pairs, ids); // exercised for coverage; not diffed
  const nAdoptRaw = await fetchAdoptiveEdges(ids);
  const nAdopted = new Set(
    nAdoptRaw.map((e) => `${e.from}->${e.to}`).filter((e) => keep2(nKept, e)),
  );
  const nSpine = new Set(
    pairs
      .map((e) => `${e.from}->${e.to}`)
      .filter((e) => keep2(nKept, e) && !nAdopted.has(e)),
  );
  const nSex = new Map<string, string>();
  for (const n of rawNodes)
    if (nKept.has(n.qid) && n.sex) nSex.set(n.qid, n.sex);

  console.log("Parity (old vs new):");
  let ok = true;
  ok = diff("kept nodes", oKept, nKept) && ok;
  ok = diff("PARENT_OF spine", oSpine, nSpine) && ok;
  ok = diff("ADOPTIVE_PARENT_OF", oAdopted, nAdopted) && ok;
  const sexKeys = (m: Map<string, string>) =>
    new Set([...m].map(([q, s]) => `${q}=${s}`));
  ok = diff("sex", sexKeys(oSex), sexKeys(nSex)) && ok;

  console.log(ok ? "\nPARITY OK ✅" : "\nPARITY FAILED ❌");
  if (!ok) process.exit(1);
}

await main();
