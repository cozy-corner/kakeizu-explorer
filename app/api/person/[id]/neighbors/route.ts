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
    // stored edge once. Blood descent traverses `hops`, but adoption is gathered
    // only 1 hop from the focus — otherwise it would bridge in the adoptive
    // parents'/children's whole families (家茂's wife, the 田安/高須 lines, …).
    // Adoption edges are also DRAWN only when incident to the focus: between
    // descendants (e.g. the 御三卿 succession 斉敦→斉朝→斉温→斉荘…) they chain in
    // the layout and inflate the apparent generation depth past `hops`.
    const rows = await runQuery<NeighborRow>(
      `MATCH (c:Person {qid: $id})
       // Competing blood fathers of the focus's children: a 落胤説/諸説 second
       // father (e.g. 近藤能成 against 頼朝 over 大友能直) is a false bridge into an
       // unrelated line. Collect them first so the descent walk can skip the whole
       // branch — not just the father but everyone reachable only through him
       // (his ancestors/other kin would otherwise float at hops≥3). Gate on an
       // explicit 'male' for BOTH — NOT the patrilineal "not female": here a wrong
       // guess DELETES nodes, so an unrecorded-sex co-parent stays a mother and an
       // unrecorded-sex ego isn't assumed a father. Adoption is ADOPTIVE_PARENT_OF,
       // not PARENT_OF, so 養父 is untouched.
       OPTIONAL MATCH (c)-[:PARENT_OF]->(:Person)<-[:PARENT_OF]-(rival:Person)
       WHERE rival <> c
         AND coalesce(c.sex, '') = 'male' AND coalesce(rival.sex, '') = 'male'
       WITH c, collect(DISTINCT rival) AS blocked
       OPTIONAL MATCH path = (c)-[:PARENT_OF*1..${hops}]-(m:Person)
       WHERE m IS NULL OR none(n IN nodes(path) WHERE n IN blocked)
       WITH c, collect(DISTINCT m) AS bio
       OPTIONAL MATCH (c)-[:ADOPTIVE_PARENT_OF]-(ad:Person)
       WITH c, bio, collect(DISTINCT ad) AS adlist
       WITH [c] + [x IN bio WHERE x <> c]
            + [x IN adlist WHERE x <> c AND NOT x IN bio] AS nodes
       UNWIND nodes AS a
       OPTIONAL MATCH (a)-[r:PARENT_OF|SPOUSE_OF|ADOPTIVE_PARENT_OF]->(b:Person)
       WHERE b IN nodes
         AND (type(r) <> 'ADOPTIVE_PARENT_OF' OR a.qid = $id OR b.qid = $id)
       RETURN a.qid AS aQid, a.label AS aLabel, a.sex AS aSex,
              type(r) AS type, b.qid AS bQid, b.label AS bLabel, b.sex AS bSex`,
      { id },
      (r) => ({
        aQid: r.get("aQid"),
        aLabel: r.get("aLabel"),
        aSex: r.get("aSex"),
        type: r.get("type"),
        bQid: r.get("bQid"),
        bLabel: r.get("bLabel"),
        bSex: r.get("bSex"),
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
