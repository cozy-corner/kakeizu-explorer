import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import { pathToGraph, type PathRow } from "@/lib/graph";

// Reads the query string and hits the DB at request time, so opt out of static
// optimization.
export const dynamic = "force-dynamic";

// shortestPath is native Cypher (no GDS plugin). The hop cap bounds the search.
// Blood-only paths run systematically longer than ones allowed a marriage
// shortcut, so the old 20 truncated real results: on a 200-pair sample, 18 of the
// 27 pairs that lost their path reconnected within 21–30 hops. Raising the cap is
// free — measured latency was flat from 20 to 60, since the search cost is bounded
// by the reachable component, not the cap.
const MAX_HOPS = 60;

// SPOUSE_OF is opt-in: it hops between houses without advancing a generation, so
// including it hides the lineage the view exists to show. Blood-only means every
// turn in the path is a common ancestor or a common child.
// SIBLING_OF is never traversed. The ego view doesn't draw it, so a sibling hop
// would assert a link that vanishes when the user taps through to that person.
function pathRelTypes(includeSpouses: boolean): string {
  return includeSpouses ? "PARENT_OF|SPOUSE_OF" : "PARENT_OF";
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = params.get("from")?.trim() ?? "";
  const to = params.get("to")?.trim() ?? "";
  const includeSpouses = params.get("spouses") === "1";
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
       MATCH p = shortestPath((a)-[:${pathRelTypes(includeSpouses)}*..${MAX_HOPS}]-(b))
       UNWIND relationships(p) AS r
       RETURN startNode(r).qid AS sourceQid, startNode(r).label AS sourceLabel,
              startNode(r).wikipediaTitle AS sourceWikipediaTitle,
              endNode(r).qid AS targetQid, endNode(r).label AS targetLabel,
              endNode(r).wikipediaTitle AS targetWikipediaTitle,
              type(r) AS type`,
      { from, to },
      (r) => ({
        sourceQid: r.get("sourceQid"),
        sourceLabel: r.get("sourceLabel"),
        sourceWikipediaTitle: r.get("sourceWikipediaTitle"),
        targetQid: r.get("targetQid"),
        targetLabel: r.get("targetLabel"),
        targetWikipediaTitle: r.get("targetWikipediaTitle"),
        type: r.get("type"),
      }),
    );
    return NextResponse.json(pathToGraph(rows));
  } catch (err) {
    return serviceUnavailable("Path lookup failed", err);
  }
}
