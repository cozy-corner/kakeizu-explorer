import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";
import type { PersonRow } from "@/lib/graph";

// Reads the path param and hits the DB at request time, so opt out of static
// optimization.
export const dynamic = "force-dynamic";

// Resolve one person by exact qid — used to seed the focus person from a
// `?id=` URL param without a graph fetch. Neighbors returns the whole subgraph;
// search is a substring match, so neither fits an exact single-person lookup.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const rows = await runQuery<PersonRow>(
      `MATCH (p:Person {qid: $id})
       RETURN p.qid AS qid, p.label AS label,
              p.wikipediaTitle AS wikipediaTitle`,
      { id },
      (r) => ({
        qid: r.get("qid"),
        label: r.get("label"),
        wikipediaTitle: r.get("wikipediaTitle"),
      }),
    );
    const person = rows[0];
    if (!person) {
      return NextResponse.json(
        { status: "error", message: "Person not found" },
        { status: 404 },
      );
    }
    // Normalize null → absent, matching personsToGraph so every person-producing
    // route yields the same optional-wikipediaTitle shape the client expects.
    return NextResponse.json({
      qid: person.qid,
      label: person.label,
      wikipediaTitle: person.wikipediaTitle ?? undefined,
    });
  } catch (err) {
    return serviceUnavailable("Person lookup failed", err);
  }
}
