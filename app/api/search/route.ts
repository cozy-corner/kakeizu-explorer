import neo4j from "neo4j-driver";
import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import { personsToGraph, type PersonRow } from "@/lib/graph";

// Reads the query string and hits the DB at request time, so opt out of static
// optimization (build-time execution).
export const dynamic = "force-dynamic";

const LIMIT = 20;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Skip the DB scan when there's nothing to match.
  if (!q) {
    return NextResponse.json(personsToGraph([]));
  }

  try {
    const rows = await runQuery<PersonRow>(
      // neo4j.int: a plain JS number binds as a Cypher Float, which LIMIT rejects.
      `MATCH (p:Person)
       WHERE toLower(p.label) CONTAINS toLower($q)
       RETURN p.qid AS qid, p.label AS label,
              p.wikipediaTitle AS wikipediaTitle
       ORDER BY p.label
       LIMIT $limit`,
      { q, limit: neo4j.int(LIMIT) },
      (r) => ({
        qid: r.get("qid"),
        label: r.get("label"),
        wikipediaTitle: r.get("wikipediaTitle"),
      }),
    );
    return NextResponse.json(personsToGraph(rows));
  } catch (err) {
    return serviceUnavailable("Search failed", err);
  }
}
