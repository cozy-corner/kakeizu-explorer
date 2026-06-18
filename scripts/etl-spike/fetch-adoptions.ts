// Disposable ETL spike: fetch ADOPTION relations from Wikidata and add them as
// ADOPTIVE_PARENT_OF edges, separate from the biological PARENT_OF spine.
//
// Why a dedicated pass (not part of fetch.ts): adoption lives in P1038 (relative)
// qualified by P1039 (kinship to subject) — NOT in P22/P25/P40 — and needs the
// reified statement form (p:/ps:/pq:) that fetch.ts's truthy `wdt:` queries can't
// reach. We restrict to pairs where BOTH endpoints already exist in the loaded
// graph (like spouse/sibling), so this never expands the node set.
//
// Direction: P1039's value is the OBJECT's kinship TO the subject. "養父/養母" ⇒
// the object is the subject's adoptive parent (edge object→subject); the adopted-
// child kinds ⇒ the object is the subject's adoptive child (edge subject→object).
// 猶子 (nominal adoption) is included by request.
//
// The graph is already loaded in Neo4j and its source JSON is gitignored, so this
// reads the node set straight from Neo4j and MERGEs the edges in directly (and
// also writes adopted_of.json so a full load.ts rebuild stays correct).
//
// Run (after the graph is loaded): bun run scripts/etl-spike/fetch-adoptions.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "neo4j-driver";
import { getDriver } from "../../lib/neo4j";
import { qid, sparql, sparqlValues } from "./wdqs";

const DATA_DIR = join(import.meta.dirname, "data");
const BATCH = 120; // subjects per WDQS query (heavier reified form → keep small)

// P1039 kinship values that mean "the object is the subject's adoptive PARENT".
const PARENT_ROLE = new Set(["Q61740757" /* 養父 */, "Q61740758" /* 養母 */]);
// ...and the ones that mean "the object is the subject's adoptive CHILD".
const CHILD_ROLE = [
  "Q25858158", // 養子 (legal, any gender)
  "Q20746725", // 養男子 (legal, male)
  "Q20746728", // 養女 (legal, female)
  "Q110267632", // adoptee
  "Q11572068", // 猶子 (nominal adoption)
  "Q6933584", // 婿養子 (adopted son-in-law)
];
const KINSHIP = [...PARENT_ROLE, ...CHILD_ROLE];

const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

async function allQids(session: Session): Promise<string[]> {
  const res = await session.run("MATCH (p:Person) RETURN p.qid AS qid");
  return res.records.map((r) => r.get("qid") as string);
}

async function main() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const qids = await allQids(session);
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
          ?s p:P1038 ?st. ?st ps:P1038 ?o. ?st pq:P1039 ?k.
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
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      join(DATA_DIR, "adopted_of.json"),
      JSON.stringify(adoptedOf),
    );
    console.log(`Found ${adoptedOf.length} ADOPTIVE_PARENT_OF edges`);

    // The base graph is already loaded, so MERGE these in directly instead of a
    // full wipe-reload (which would need the gitignored source JSON).
    for (const rows of chunk(adoptedOf, 5000)) {
      await session.run(
        "UNWIND $rows AS r MATCH (a:Person {qid: r.from}), (b:Person {qid: r.to}) MERGE (a)-[:ADOPTIVE_PARENT_OF]->(b)",
        { rows },
      );
    }
    const res = await session.run(
      "MATCH ()-[r:ADOPTIVE_PARENT_OF]->() RETURN count(r) AS n",
    );
    console.log(
      `Neo4j ADOPTIVE_PARENT_OF: ${res.records[0].get("n").toNumber()}`,
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
