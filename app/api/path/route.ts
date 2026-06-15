import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import { pathToGraph, type PathRow } from "@/lib/graph";

// Reads the query string and hits the DB at request time, so opt out of static
// optimization (build-time execution).
export const dynamic = "force-dynamic";

// shortestPath is native Cypher (no GDS plugin). The hop cap bounds the search;
// 20 matches the ETL spike, well beyond the connected core's real diameter.
const MAX_HOPS = 20;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = params.get("from")?.trim() ?? "";
  const to = params.get("to")?.trim() ?? "";
  // Both endpoints required, and distinct: shortestPath errors when start === end.
  // Treat these as "no path" (same UI message) rather than a distinct error —
  // the UI never sends them (its 経路 button is hidden for the focus person).
  if (!from || !to || from === to) {
    return NextResponse.json(pathToGraph([]));
  }

  try {
    // A disconnected pair yields zero rows → an empty graph, which the UI
    // renders as "経路が見つかりません".
    const rows = await runQuery<PathRow>(
      `MATCH (a:Person {qid: $from}), (b:Person {qid: $to})
       MATCH p = shortestPath((a)-[:PARENT_OF|SPOUSE_OF|SIBLING_OF*..${MAX_HOPS}]-(b))
       UNWIND relationships(p) AS r
       RETURN startNode(r).qid AS sourceQid, startNode(r).label AS sourceLabel,
              endNode(r).qid AS targetQid, endNode(r).label AS targetLabel,
              type(r) AS type`,
      { from, to },
      (r) => ({
        sourceQid: r.get("sourceQid"),
        sourceLabel: r.get("sourceLabel"),
        targetQid: r.get("targetQid"),
        targetLabel: r.get("targetLabel"),
        type: r.get("type"),
      }),
    );
    return NextResponse.json(pathToGraph(rows));
  } catch (err) {
    return serviceUnavailable("Path lookup failed", err);
  }
}
