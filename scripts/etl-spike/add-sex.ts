// Additive ETL step: tag existing :Person nodes with Wikidata sex (P21) so the
// app can render a patrilineal tree (father = male parent). Does NOT touch the
// graph topology — only SETs p.sex. Re-runnable; WDQS results are cached.
//
// Run: bun --env-file=.env.development run scripts/etl-spike/add-sex.ts

import type { Session } from "neo4j-driver";
import { getDriver } from "../../lib/neo4j";
import { qid, sparql, sparqlValues } from "./wdqs";

const BATCH = 400; // VALUES list size per WDQS query (keeps us well under the 60s timeout)

const SEX_QID: Record<string, "male" | "female"> = {
  Q6581097: "male",
  Q6581072: "female",
};

async function allQids(session: Session): Promise<string[]> {
  const res = await session.run("MATCH (p:Person) RETURN p.qid AS qid");
  return res.records.map((r) => r.get("qid") as string);
}

// Map each qid to male/female/other. Multiple P21 (rare) → first wins; anything
// that isn't plain male/female (intersex, trans, …) collapses to "other".
async function fetchSex(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < qids.length; i += BATCH) {
    const values = sparqlValues(qids.slice(i, i + BATCH));
    const rows = await sparql(
      `SELECT ?p ?sex WHERE { VALUES ?p { ${values} } ?p wdt:P21 ?sex. }`,
    );
    for (const r of rows) {
      const p = qid(r.p!.value);
      if (out.has(p)) continue;
      out.set(p, SEX_QID[qid(r.sex!.value)] ?? "other");
    }
    console.log(
      `  P21 fetched: ${Math.min(i + BATCH, qids.length)}/${qids.length}`,
    );
  }
  return out;
}

async function main() {
  const driver = getDriver();
  const session = driver.session();
  try {
    const qids = await allQids(session);
    console.log(`Persons in DB: ${qids.length}`);
    const sex = await fetchSex(qids);
    console.log(`With sex on Wikidata: ${sex.size}`);

    const rows = [...sex].map(([q, s]) => ({ qid: q, sex: s }));
    for (let i = 0; i < rows.length; i += 5000) {
      await session.run(
        "UNWIND $rows AS r MATCH (p:Person {qid: r.qid}) SET p.sex = r.sex",
        { rows: rows.slice(i, i + 5000) },
      );
    }
    const counts = await session.run(
      "MATCH (p:Person) RETURN p.sex AS sex, count(*) AS n ORDER BY n DESC",
    );
    console.log("sex distribution:");
    for (const r of counts.records) {
      console.log(`  ${r.get("sex") ?? "(unset)"}: ${r.get("n").toNumber()}`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
