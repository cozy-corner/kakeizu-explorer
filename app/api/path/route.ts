import { NextResponse } from "next/server";
import { CACHE_STABLE, runQuery, serviceUnavailable } from "@/lib/api";
import { pathToGraph, type PathRow } from "@/lib/graph";

// Reads the query string and hits the DB at request time, so opt out of static
// optimization.
export const dynamic = "force-dynamic";

// shortestPath is native Cypher (no GDS plugin). Blood-only paths run
// systematically longer than ones allowed a marriage shortcut — on real data a cap
// of 20 cut off pairs that reconnect in 21–30 hops — and a high cap costs nothing:
// measured latency was flat from 20 to 60, the search being bounded by the
// reachable component rather than the cap.
const MAX_HOPS = 60;

// A marriage hop crosses between houses without advancing a generation, so it is
// opt-in: with blood only, every turn in the path is a common ancestor or a common
// child. SIBLING_OF is deliberately absent — the ego view never draws it, so a
// sibling hop would assert a link that vanishes when the user taps through.
export function pathRelTypes(
  includeSpouses: boolean,
): "PARENT_OF" | "PARENT_OF|SPOUSE_OF" {
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
    return NextResponse.json(pathToGraph([]), { headers: CACHE_STABLE });
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
    return NextResponse.json(pathToGraph(rows), { headers: CACHE_STABLE });
  } catch (err) {
    return serviceUnavailable("Path lookup failed", err);
  }
}
