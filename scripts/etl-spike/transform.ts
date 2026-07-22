// T stage: pure-local transform, ZERO WDQS. Reads the extract stage's raw-*.json and
// emits the load inputs (nodes / parent_of / spouse_of / sibling_of / adopted_of).
//
// Run (after fetch.ts + traverse.ts): bun run scripts/etl-spike/transform.ts
//                                     (then load.ts)

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATA_DIR,
  RAW_ADOPTIONS,
  RAW_NODES,
  RAW_PARENT,
  RAW_SIBLING,
  RAW_SPOUSE,
  type RawAdoptiveEdge,
  type RawNode,
  type RawPair,
  type RawParentEdge,
  readRaw,
} from "./raw";

const JAPAN = "Q17";

async function main() {
  const nodes = await readRaw<RawNode[]>(RAW_NODES);
  const parent = await readRaw<RawParentEdge[]>(RAW_PARENT);
  const spouse = await readRaw<RawPair[]>(RAW_SPOUSE);
  const sibling = await readRaw<RawPair[]>(RAW_SIBLING);
  const adoptions = await readRaw<RawAdoptiveEdge[]>(RAW_ADOPTIONS);

  // Foreign = has a P27 nationality but none is Japanese (P27 ∋ Q17, or a P27 country
  // via P27→P17 is Q17). No-P27 bridge relatives and Japan+other dual nationals are
  // kept; birthplace is deliberately unused.
  const isJapanese = (n: RawNode) =>
    n.nationalities.includes(JAPAN) || n.nationalityCountries.includes(JAPAN);
  const isForeign = (n: RawNode) =>
    n.nationalities.length > 0 && !isJapanese(n);

  const keptNodes = nodes.filter((n) => !isForeign(n));
  const inGraph = new Set(keptNodes.map((n) => n.qid));
  const keep2 = (a: string, b: string) => inGraph.has(a) && inGraph.has(b);

  const keptSpouse = spouse.filter((e) => keep2(e.a, e.b));
  const keptSibling = sibling.filter((e) => keep2(e.a, e.b));
  // Restricted to in-graph nodes (parity with fetch-adoptions.ts's known.has(o) guard).
  const keptAdoptions = adoptions.filter((e) => keep2(e.from, e.to));

  // Wikidata records a parent link as two unsynced statements (child-side P22/P25,
  // parent-side P40); a truthy query keeps the edge if EITHER side's best rank is
  // non-deprecated, so a parent-side P40 can leak a father the child side deprecated
  // as wrong (disputed parentage / rumored-illegitimate-child). Drop the pair when
  // either side's rank is deprecated.
  const isDeprecatedParent = (e: RawParentEdge) =>
    e.childSideRank === "deprecated" || e.parentSideRank === "deprecated";

  // Adoptive edges (however discovered — fetch- or traverse-found) are split out of
  // the biological PARENT_OF spine and kept only as ADOPTIVE_PARENT_OF.
  const adoptiveKeys = new Set(keptAdoptions.map((e) => `${e.from}->${e.to}`));
  const spine = parent.filter(
    (e) =>
      keep2(e.from, e.to) &&
      !adoptiveKeys.has(`${e.from}->${e.to}`) &&
      !isDeprecatedParent(e),
  );

  const nodeRows = keptNodes.map((n) => ({
    qid: n.qid,
    label: n.label,
    sex: n.sex,
    wikipediaTitle: n.wikipediaTitle,
  }));
  const parentRows = spine.map((e) => ({ from: e.from, to: e.to }));

  const out = async (name: string, data: unknown) =>
    writeFile(join(DATA_DIR, name), JSON.stringify(data));
  await out("nodes.json", nodeRows);
  await out("parent_of.json", parentRows);
  await out("spouse_of.json", keptSpouse);
  await out("sibling_of.json", keptSibling);
  await out("adopted_of.json", keptAdoptions);

  const foreign = nodes.length - keptNodes.length;
  // Mirror the spine gate so this counts only deprecation-drops, not adoptive
  // removals — exact even though in practice the two never overlap (an adoptive key
  // implies a non-deprecated statement).
  const deprecated = parent.filter(
    (e) =>
      keep2(e.from, e.to) &&
      !adoptiveKeys.has(`${e.from}->${e.to}`) &&
      isDeprecatedParent(e),
  ).length;
  console.log(
    `Kept ${keptNodes.length} nodes (pruned ${foreign} foreign), ` +
      `${parentRows.length} PARENT_OF (dropped ${deprecated} deprecated), ` +
      `${keptSpouse.length} SPOUSE_OF, ` +
      `${keptSibling.length} SIBLING_OF, ${keptAdoptions.length} ADOPTIVE_PARENT_OF`,
  );
}

await main();
