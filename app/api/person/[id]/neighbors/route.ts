import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import { neighborsToGraph, type NeighborRow } from "@/lib/graph";

// Reads request data, so it can't be statically prerendered.
export const dynamic = "force-dynamic";

const DEFAULT_HOPS = 2;
const MAX_HOPS = 3;

// A variable-length pattern bound can't be a Cypher parameter, so clamp to a
// small integer and interpolate it (safe: never a raw client string).
function parseHops(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOPS ? n : DEFAULT_HOPS;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hops = parseHops(new URL(request.url).searchParams.get("hops"));

  try {
    // One row per subgraph node (edge columns null when it has none) so an
    // isolated focus person still returns a row; directed `->` yields each
    // stored edge once.
    const rows = await runQuery<NeighborRow>(
      `MATCH (c:Person {qid: $id})
       OPTIONAL MATCH (c)-[:PARENT_OF|SPOUSE_OF|SIBLING_OF*1..${hops}]-(m:Person)
       WITH c, collect(DISTINCT m) AS ms
       WITH [c] + [x IN ms WHERE x <> c] AS nodes
       UNWIND nodes AS a
       OPTIONAL MATCH (a)-[r:PARENT_OF|SPOUSE_OF|SIBLING_OF]->(b:Person)
       WHERE b IN nodes
       RETURN a.qid AS aQid, a.label AS aLabel,
              type(r) AS type, b.qid AS bQid, b.label AS bLabel`,
      { id },
      (r) => ({
        aQid: r.get("aQid"),
        aLabel: r.get("aLabel"),
        type: r.get("type"),
        bQid: r.get("bQid"),
        bLabel: r.get("bLabel"),
      }),
    );

    const graph = neighborsToGraph(rows);
    // No rows ⟺ the person id doesn't exist (an isolated person still yields one).
    if (graph.nodes.length === 0) {
      return NextResponse.json(
        { status: "error", message: "Person not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(graph);
  } catch (err) {
    return serviceUnavailable("Neighbors lookup failed", err);
  }
}
