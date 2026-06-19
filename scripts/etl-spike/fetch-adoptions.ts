// Disposable ETL spike: fetch ADOPTION relations from Wikidata and write them to
// adopted_of.json for load.ts, separate from the biological PARENT_OF spine.
//
// Why a dedicated stage (not part of fetch.ts): adoption is recorded two ways —
// in P1038 (relative) qualified by P1039 (kinship to subject), AND inside the
// ordinary P22/P25/P40 (father/mother/child) statements carrying the same P1039
// qualifier. Both need the reified statement form (p:/ps:/pq:) that fetch.ts's
// truthy `wdt:` queries can't reach — fetch.ts only EXCLUDES the P22/P25/P40 ones
// from the biological spine; this stage turns them into adoption edges.
// We restrict to pairs where BOTH endpoints already exist in the graph
// (like spouse/sibling), so this never expands the node set. That node set is the
// FINAL one — after traverse.ts adds frontier nodes and filter-foreign.ts prunes
// foreign ones — so this reads the post-prune nodes.json, NOT fetch.ts's raw
// output. It runs as a normal pipeline stage (→ JSON) and load.ts is the single
// loader; no direct Neo4j writes here.
//
// Direction: P1039's value is the OBJECT's kinship TO the subject. "養父/養母" ⇒
// the object is the subject's adoptive parent (edge object→subject); the adopted-
// child kinds ⇒ the object is the subject's adoptive child (edge subject→object).
// 猶子 (nominal adoption) is included by request.
//
// Run (after filter-foreign.ts, before load.ts):
//   bun run scripts/etl-spike/fetch-adoptions.ts

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KINSHIP, PARENT_ROLE } from "./adoption-roles";
import { qid, sparql, sparqlValues } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const BATCH = 120; // subjects per WDQS query (heavier reified form → keep small)

const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")) as T;
}

async function main() {
  const nodes = await readJson<{ qid: string; label: string }[]>("nodes.json");
  const qids = nodes.map((n) => n.qid);
  const known = new Set(qids);
  console.log(`Known nodes: ${qids.length}`);

  const kinshipValues = sparqlValues(KINSHIP);
  const edges = new Set<string>(); // `from->to`, deduped (adoptiveParent→child)
  const batches = chunk(qids, BATCH);
  for (let i = 0; i < batches.length; i++) {
    const rows = await sparql(`
      SELECT ?s ?o ?k WHERE {
        VALUES ?s { ${sparqlValues(batches[i])} }
        VALUES ?k { ${kinshipValues} }
        {
          { ?s p:P1038 ?st. ?st ps:P1038 ?o. }
          UNION { ?s p:P22 ?st. ?st ps:P22 ?o. }
          UNION { ?s p:P25 ?st. ?st ps:P25 ?o. }
          UNION { ?s p:P40 ?st. ?st ps:P40 ?o. }
        }
        ?st pq:P1039 ?k.
        # Reified p:/ps: returns all ranks; drop DeprecatedRank (known-wrong) so
        # it doesn't become an edge — wdt: would have excluded it automatically.
        ?st wikibase:rank ?rank.
        FILTER(?rank != wikibase:DeprecatedRank)
      }`);
    for (const r of rows) {
      const s = qid(r.s!.value);
      const o = qid(r.o!.value);
      const k = qid(r.k!.value);
      if (s === o || !known.has(o)) continue;
      // Orient to adoptiveParent→child regardless of which side recorded it.
      const [from, to] = PARENT_ROLE.has(k) ? [o, s] : [s, o];
      edges.add(`${from}->${to}`);
    }
    if ((i + 1) % 20 === 0)
      console.log(
        `  batch ${i + 1}/${batches.length}, edges so far ${edges.size}`,
      );
  }

  const adoptedOf = [...edges].map((e) => {
    const [from, to] = e.split("->");
    return { from, to };
  });
  await writeFile(join(DATA_DIR, "adopted_of.json"), JSON.stringify(adoptedOf));
  console.log(
    `Wrote ${adoptedOf.length} ADOPTIVE_PARENT_OF edges to adopted_of.json`,
  );
}

await main();
