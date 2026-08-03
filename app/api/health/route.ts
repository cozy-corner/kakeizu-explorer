import { NextResponse } from "next/server";
import { CACHE_NONE, runQuery, serviceUnavailable } from "@/lib/api";

// Hits the DB at request time, so opt out of static optimization.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [ok] = await runQuery("RETURN 1 AS ok", {}, (r) => r.get("ok"));
    // Liveness must reflect the DB right now, so it is the one route that is never
    // cached even on success.
    return NextResponse.json(
      { status: "ok", neo4j: ok },
      { headers: CACHE_NONE },
    );
  } catch (err) {
    return serviceUnavailable("Health check failed", err);
  }
}
