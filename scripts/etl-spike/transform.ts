// T stage (issue #44): pure-local transform, ZERO WDQS. Reads the raw-*.json the
// extract stage captured and emits the load inputs (nodes.json / parent_of.json /
// spouse_of.json / sibling_of.json / adopted_of.json). Replaces the former
// filter-foreign.ts (foreign pruning) and fetch-adoptions.ts (adoptive split),
// which each re-queried Wikidata; the same logic now runs over raw attributes.
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

  // Foreign pruning (broad rule): a node is foreign — and removed — iff it has a
  // nationality (P27) but none of its citizenships is Japanese, where Japanese =
  // P27 ∋ Q17 OR one of its P27's countries (P27→P17) is Q17. Untagged bridge
  // relatives (no P27) and dual nationals (Japan + other) are kept. Birthplace is
  // deliberately unused. Same rule as the former filter-foreign.ts, now local.
  const isJapanese = (n: RawNode) =>
    n.nationalities.includes(JAPAN) || n.nationalityCountries.includes(JAPAN);
  const isForeign = (n: RawNode) =>
    n.nationalities.length > 0 && !isJapanese(n);

  const keptNodes = nodes.filter((n) => !isForeign(n));
  const inGraph = new Set(keptNodes.map((n) => n.qid));
  const keep2 = (a: string, b: string) => inGraph.has(a) && inGraph.has(b);

  const keptSpouse = spouse.filter((e) => keep2(e.a, e.b));
  const keptSibling = sibling.filter((e) => keep2(e.a, e.b));
  // Adoptive relations restricted to in-graph nodes (matches fetch-adoptions.ts's
  // known.has(o) guard).
  const keptAdoptions = adoptions.filter((e) => keep2(e.from, e.to));

  // Adoptive split (consistent orientation): every adoptive parent→child edge is
  // an ADOPTIVE_PARENT_OF and is removed from the biological PARENT_OF spine —
  // both fetch- and traverse-discovered alike (see PR notes: this drops the old
  // asymmetry where traverse-found adoptions leaked into the spine).
  const adoptiveKeys = new Set(keptAdoptions.map((e) => `${e.from}->${e.to}`));
  const spine = parent.filter(
    (e) => keep2(e.from, e.to) && !adoptiveKeys.has(`${e.from}->${e.to}`),
  );

  const nodeRows = keptNodes.map((n) => ({
    qid: n.qid,
    label: n.label,
    sex: n.sex,
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
  console.log(
    `Kept ${keptNodes.length} nodes (pruned ${foreign} foreign), ` +
      `${parentRows.length} PARENT_OF, ${keptSpouse.length} SPOUSE_OF, ` +
      `${keptSibling.length} SIBLING_OF, ${keptAdoptions.length} ADOPTIVE_PARENT_OF`,
  );
}

await main();
