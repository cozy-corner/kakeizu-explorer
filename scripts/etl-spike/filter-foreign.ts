// Disposable spike experiment (PR2): prune the "world genealogy" leak that
// seed-and-traverse pulls in (e.g. Yoko Ono → John Lennon → Lennon family).
//
// Rule (proposed by the user): a node is FOREIGN — and removed — iff it has a
// positive foreign signal and NO Japanese one:
//   foreign = NOT(P27 includes Japan) AND ( has any P27  OR  born outside Japan )
// Untagged bridge relatives ("X's daughter", no P27/P19) are kept; dual
// nationals (Japan + other, e.g. Yoko Ono) are kept.
//
// Run (after traverse.ts): bun run scripts/etl-spike/filter-foreign.ts
//                          (then load.ts / verify.ts)

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sparql } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const BATCH = 400;

const qid = (uri: string) => uri.replace("http://www.wikidata.org/entity/", "");
const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const values = (qids: string[]) => qids.map((q) => `wd:${q}`).join(" ");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")) as T;
}

// Members of `qids` for which EXISTS{ pattern } holds.
async function existsSweep(
  qids: string[],
  pattern: string,
): Promise<Set<string>> {
  const hit = new Set<string>();
  for (const b of chunk(qids, BATCH)) {
    const rows = await sparql(
      `SELECT ?item WHERE { VALUES ?item { ${values(b)} } ${pattern} }`,
    );
    for (const r of rows) hit.add(qid(r.item!.value));
  }
  return hit;
}

async function main() {
  const nodes = await readJson<{ qid: string; label: string }[]>("nodes.json");
  const parent =
    await readJson<{ from: string; to: string }[]>("parent_of.json");
  const spouse = await readJson<{ a: string; b: string }[]>("spouse_of.json");
  const sibling = await readJson<{ a: string; b: string }[]>("sibling_of.json");
  const labelOf = new Map(nodes.map((n) => [n.qid, n.label]));
  const all = nodes.map((n) => n.qid);

  console.log(`Classifying ${all.length} nodes…`);
  // "Japanese" = citizen of Japan (Q17) OR of a historical state whose country
  // (P17) is Japan — Edo shogunate / Empire of Japan / Kamakura·Muromachi etc.
  // Using only P27=Q17 wrongly flags pre-modern figures (於大の方, 愛姫, whose
  // P27 is 江戸幕府) as foreign.
  const jpNat = await existsSweep(
    all,
    "{ ?item wdt:P27 wd:Q17. } UNION { ?item wdt:P27/wdt:P17 wd:Q17. }",
  );
  const anyNat = await existsSweep(all, "?item wdt:P27 [].");

  // Foreign = has a nationality, none of which is Japanese. Birthplace is
  // deliberately NOT used: P17 on old Japanese places is unreliable, so a
  // born-foreign rule cuts real Japanese figures.
  const foreign = new Set(all.filter((q) => anyNat.has(q) && !jpNat.has(q)));
  const keep = (q: string) => !foreign.has(q);

  const sample = [...foreign].slice(0, 8).map((q) => labelOf.get(q) ?? q);
  console.log(`  JP-nationality: ${jpNat.size}`);
  console.log(`  foreign (removed): ${foreign.size}`);
  console.log(`  sample removed: ${sample.join(", ")}`);

  const keptNodes = nodes.filter((n) => keep(n.qid));
  const keptParent = parent.filter((e) => keep(e.from) && keep(e.to));
  const keptSpouse = spouse.filter((e) => keep(e.a) && keep(e.b));
  const keptSibling = sibling.filter((e) => keep(e.a) && keep(e.b));

  await writeFile(join(DATA_DIR, "nodes.json"), JSON.stringify(keptNodes));
  await writeFile(join(DATA_DIR, "parent_of.json"), JSON.stringify(keptParent));
  await writeFile(join(DATA_DIR, "spouse_of.json"), JSON.stringify(keptSpouse));
  await writeFile(
    join(DATA_DIR, "sibling_of.json"),
    JSON.stringify(keptSibling),
  );
  console.log(
    `Kept: ${keptNodes.length} nodes, ${keptParent.length} PARENT_OF, ${keptSpouse.length} SPOUSE_OF, ${keptSibling.length} SIBLING_OF`,
  );
}

await main();
