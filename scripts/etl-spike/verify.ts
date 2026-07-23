// Disposable ETL spike: the actual go/no-go checks.
//   1. Connectivity — what fraction of nodes is the largest weakly connected
//      component (gds.wcc)? If most people sit in one big component, "walking
//      from person to person" works.
//   2. Path quality — does shortestPath return plausible paths between known
//      historical figures (and do marriage/sibling edges help)?
//
// Run (after load.ts): bun run scripts/etl-spike/verify.ts
// Requires the graph-data-science plugin (see docker-compose.yml).

import type { Session } from "neo4j-driver";
import { getDriver } from "../../lib/neo4j";

const GRAPH = "spike";

// Known figures to probe path existence/quality.
const PEOPLE: Record<string, string> = {
  信長: "Q171411",
  家康: "Q171977",
  秀吉: "Q187550",
  頼朝: "Q242800",
  清盛: "Q281833",
  昭和天皇: "Q34479",
  明仁: "Q37979",
};
const PAIRS: [string, string][] = [
  ["昭和天皇", "明仁"], // parent-child sanity check → expect 1 hop
  ["信長", "家康"],
  ["家康", "秀吉"],
  ["信長", "秀吉"],
  ["信長", "頼朝"],
  ["家康", "清盛"],
];

async function connectivity(session: Session): Promise<void> {
  await session.run("CALL gds.graph.drop($g, false)", { g: GRAPH });
  await session.run(
    `CALL gds.graph.project($g, 'Person', {
       PARENT_OF:  { orientation: 'UNDIRECTED' },
       SPOUSE_OF:  { orientation: 'UNDIRECTED' },
       SIBLING_OF: { orientation: 'UNDIRECTED' }
     })`,
    { g: GRAPH },
  );
  try {
    const total = (
      await session.run("MATCH (p:Person) RETURN count(p) AS n")
    ).records[0]
      .get("n")
      .toNumber();

    const stats = await session.run(
      `CALL gds.wcc.stats($g)
       YIELD componentCount, componentDistribution
       RETURN componentCount AS components,
              componentDistribution.max AS largest,
              componentDistribution.p99 AS p99,
              componentDistribution.mean AS mean`,
      { g: GRAPH },
    );
    const r = stats.records[0];
    const components = r.get("components").toNumber();
    const largest = r.get("largest").toNumber();
    const pct = ((largest / total) * 100).toFixed(1);

    console.log("== Connectivity (WCC, edges undirected) ==");
    console.log(`  total nodes:        ${total}`);
    console.log(`  components:         ${components}`);
    console.log(`  largest component:  ${largest} (${pct}% of nodes)`);
    console.log(`  mean component:     ${r.get("mean")}`);
  } finally {
    await session.run("CALL gds.graph.drop($g, false)", { g: GRAPH });
  }
}

async function paths(session: Session): Promise<void> {
  console.log("\n== Path quality (shortestPath, undirected, ≤20 hops) ==");
  for (const [aName, bName] of PAIRS) {
    const res = await session.run(
      `MATCH (a:Person {qid: $from}), (b:Person {qid: $to})
       MATCH p = shortestPath((a)-[*..20]-(b))
       RETURN length(p) AS hops,
              [n IN nodes(p) | n.label] AS names,
              [r IN relationships(p) | type(r)] AS rels`,
      { from: PEOPLE[aName], to: PEOPLE[bName] },
    );
    if (res.records.length === 0) {
      console.log(`  ${aName} ↔ ${bName}: NO PATH (≤20 hops)`);
      continue;
    }
    const rec = res.records[0];
    const hops = rec.get("hops").toNumber();
    const names: string[] = rec.get("names");
    const rels: string[] = rec.get("rels");
    const trail = names
      .map((n, i) => (i < rels.length ? `${n} -[${rels[i]}]- ` : n))
      .join("");
    console.log(`  ${aName} ↔ ${bName}: ${hops} hops`);
    console.log(`      ${trail}`);
  }
}

async function main() {
  const driver = getDriver();
  const session = driver.session();
  try {
    await connectivity(session);
    await paths(session);
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
