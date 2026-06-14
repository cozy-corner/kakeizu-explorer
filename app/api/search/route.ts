import neo4j from "neo4j-driver";
import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";
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
    // getDriver() can throw (missing env), so keep it inside try — otherwise the
    // throw escapes the catch below and surfaces as a 500 instead of 503.
    const session = getDriver().session();
    try {
      // neo4j.int: a plain JS number binds as a Cypher Float, which LIMIT rejects.
      const result = await session.run(
        `MATCH (p:Person)
         WHERE toLower(p.label) CONTAINS toLower($q)
         RETURN p.qid AS qid, p.label AS label
         ORDER BY p.label
         LIMIT $limit`,
        { q, limit: neo4j.int(LIMIT) },
      );
      const rows: PersonRow[] = result.records.map((r) => ({
        qid: r.get("qid"),
        label: r.get("label"),
      }));
      return NextResponse.json(personsToGraph(rows));
    } finally {
      await session.close();
    }
  } catch (err) {
    // Log details server-side, but return a generic message so internal info
    // (connection URI, auth errors, stack) is not leaked to clients.
    console.error("Search failed:", err);
    return NextResponse.json(
      { status: "error", message: "Service unavailable" },
      { status: 503 },
    );
  }
}
