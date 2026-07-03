// Disposable ETL spike (PR2): load the fetched JSON into local Neo4j.
// Idempotent — wipes the existing :Person graph first so re-runs stay clean.
//
// Run (after fetch.ts): bun run scripts/etl-spike/load.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "neo4j-driver";
import { getDriver } from "../../lib/neo4j";

const DATA_DIR = join(import.meta.dirname, "data");

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")) as T;
}

// adopted_of.json is produced by the fetch-adoptions stage. A MISSING file is
// benign (a partial pipeline run that skipped that stage) ⇒ empty; a parse error
// or I/O fault must surface, or a corrupted adopted_of.json would silently drop
// every adoption edge.
async function readJsonOpt<T>(name: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// UNWIND a list of rows through a Cypher statement in chunks to bound memory.
async function batched(
  session: Session,
  rows: unknown[],
  cypher: string,
  size = 5000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await session.run(cypher, { rows: rows.slice(i, i + size) });
  }
}

async function count(session: Session, cypher: string): Promise<number> {
  const res = await session.run(cypher);
  return res.records[0].get(0).toNumber();
}

async function main() {
  const nodes =
    await readJson<{ qid: string; label: string; sex?: string }[]>(
      "nodes.json",
    );
  const parentOf =
    await readJson<{ from: string; to: string }[]>("parent_of.json");
  const spouseOf = await readJson<{ a: string; b: string }[]>("spouse_of.json");
  const siblingOf =
    await readJson<{ a: string; b: string }[]>("sibling_of.json");
  const adoptedOf = await readJsonOpt<{ from: string; to: string }[]>(
    "adopted_of.json",
    [],
  );

  const driver = getDriver();
  const session = driver.session();
  try {
    console.log("Resetting :Person graph…");
    await session.run("MATCH (p:Person) DETACH DELETE p");
    await session.run(
      "CREATE CONSTRAINT person_qid IF NOT EXISTS FOR (p:Person) REQUIRE p.qid IS UNIQUE",
    );

    console.log(`Loading ${nodes.length} nodes…`);
    // sex comes from raw now (issue #44); r.sex is null for nodes Wikidata has no
    // P21 for, and SET …= null leaves the property unset — same as the old
    // add-sex.ts, which only tagged nodes that had a sex.
    await batched(
      session,
      nodes,
      "UNWIND $rows AS r MERGE (p:Person {qid: r.qid}) SET p.label = r.label, p.sex = r.sex",
    );

    console.log(`Loading ${parentOf.length} PARENT_OF…`);
    await batched(
      session,
      parentOf,
      "UNWIND $rows AS r MATCH (a:Person {qid: r.from}), (b:Person {qid: r.to}) MERGE (a)-[:PARENT_OF]->(b)",
    );
    console.log(`Loading ${spouseOf.length} SPOUSE_OF…`);
    await batched(
      session,
      spouseOf,
      "UNWIND $rows AS r MATCH (a:Person {qid: r.a}), (b:Person {qid: r.b}) MERGE (a)-[:SPOUSE_OF]->(b)",
    );
    console.log(`Loading ${siblingOf.length} SIBLING_OF…`);
    await batched(
      session,
      siblingOf,
      "UNWIND $rows AS r MATCH (a:Person {qid: r.a}), (b:Person {qid: r.b}) MERGE (a)-[:SIBLING_OF]->(b)",
    );
    console.log(`Loading ${adoptedOf.length} ADOPTIVE_PARENT_OF…`);
    await batched(
      session,
      adoptedOf,
      "UNWIND $rows AS r MATCH (a:Person {qid: r.from}), (b:Person {qid: r.to}) MERGE (a)-[:ADOPTIVE_PARENT_OF]->(b)",
    );

    const persons = await count(session, "MATCH (p:Person) RETURN count(p)");
    const parents = await count(
      session,
      "MATCH ()-[r:PARENT_OF]->() RETURN count(r)",
    );
    const spouses = await count(
      session,
      "MATCH ()-[r:SPOUSE_OF]->() RETURN count(r)",
    );
    const siblings = await count(
      session,
      "MATCH ()-[r:SIBLING_OF]->() RETURN count(r)",
    );
    const adoptions = await count(
      session,
      "MATCH ()-[r:ADOPTIVE_PARENT_OF]->() RETURN count(r)",
    );
    console.log("Loaded into Neo4j:");
    console.log(`  Person:             ${persons}`);
    console.log(`  PARENT_OF:          ${parents}`);
    console.log(`  SPOUSE_OF:          ${spouses}`);
    console.log(`  SIBLING_OF:         ${siblings}`);
    console.log(`  ADOPTIVE_PARENT_OF: ${adoptions}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
