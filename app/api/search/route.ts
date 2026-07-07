import neo4j from "neo4j-driver";
import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import { personsToGraph, type PersonRow, type SearchResult } from "@/lib/graph";

// Reads the query string and hits the DB at request time, so opt out of static
// optimization (build-time execution).
export const dynamic = "force-dynamic";

const LIMIT = 50;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Skip the DB scan when there's nothing to match.
  if (!q) {
    return NextResponse.json({
      ...personsToGraph([]),
      total: 0,
    } satisfies SearchResult);
  }

  try {
    // Rank by degree (COUNT { (p)--() } = directly-linked kin) so the notable
    // people surface first — a good popularity proxy in this data — instead of
    // the top 20 by alphabetical label. `total` is the full CONTAINS hit count
    // (before LIMIT), collected in the same scan and carried on every row.
    const rows = await runQuery<PersonRow & { total: number }>(
      // neo4j.int: a plain JS number binds as a Cypher Float, which LIMIT rejects.
      `MATCH (p:Person)
       WHERE toLower(p.label) CONTAINS toLower($q)
       WITH count(p) AS total, collect(p) AS ps
       UNWIND ps AS p
       WITH total, p, COUNT { (p)--() } AS degree
       RETURN total, p.qid AS qid, p.label AS label,
              p.wikipediaTitle AS wikipediaTitle
       ORDER BY degree DESC, p.label
       LIMIT $limit`,
      { q, limit: neo4j.int(LIMIT) },
      (r) => ({
        qid: r.get("qid"),
        label: r.get("label"),
        wikipediaTitle: r.get("wikipediaTitle"),
        total: r.get("total").toNumber(),
      }),
    );
    // No rows ⇒ no match ⇒ total 0 (the count row only exists alongside results).
    const total = rows[0]?.total ?? 0;
    return NextResponse.json({
      ...personsToGraph(rows),
      total,
    } satisfies SearchResult);
  } catch (err) {
    return serviceUnavailable("Search failed", err);
  }
}
