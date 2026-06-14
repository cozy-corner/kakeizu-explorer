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
  const nodes = await readJson<{ qid: string; label: string }[]>("nodes.json");
  const parentOf =
    await readJson<{ from: string; to: string }[]>("parent_of.json");
  const spouseOf = await readJson<{ a: string; b: string }[]>("spouse_of.json");
  const siblingOf =
    await readJson<{ a: string; b: string }[]>("sibling_of.json");

  const driver = getDriver();
  const session = driver.session();
  try {
    console.log("Resetting :Person graph…");
    await session.run("MATCH (p:Person) DETACH DELETE p");
    await session.run(
      "CREATE CONSTRAINT person_qid IF NOT EXISTS FOR (p:Person) REQUIRE p.qid IS UNIQUE",
    );

    console.log(`Loading ${nodes.length} nodes…`);
    await batched(
      session,
      nodes,
      "UNWIND $rows AS r MERGE (p:Person {qid: r.qid}) SET p.label = r.label",
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
    console.log("Loaded into Neo4j:");
    console.log(`  Person:     ${persons}`);
    console.log(`  PARENT_OF:  ${parents}`);
    console.log(`  SPOUSE_OF:  ${spouses}`);
    console.log(`  SIBLING_OF: ${siblings}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
