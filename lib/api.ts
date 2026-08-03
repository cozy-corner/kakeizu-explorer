import { type Record as Neo4jRecord } from "neo4j-driver";
import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";

// getDriver() throws on missing env; left here so it reaches the caller's catch
// (→ 503) rather than escaping as a 500.
export async function runQuery<T>(
  cypher: string,
  params: Record<string, unknown>,
  map: (record: Neo4jRecord) => T,
): Promise<T[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map(map);
  } finally {
    await session.close();
  }
}

// Every response below is a pure function of the URL — no auth, no cookies, no
// per-user output — so one shared CDN entry serves all visitors. Introducing any
// per-user variation would make `public` an information leak. The data is frozen
// until the ETL is re-run and redeployed, hence the long CDN lifetimes.
//
// Browser and CDN get separate headers rather than one `max-age=0, s-maxage=…`:
// browsers honour stale-while-revalidate as well, so a shared header would let a
// visitor's own cache serve week-old data after a redeploy. `CDN-Cache-Control`
// is read by the edge and ignored by browsers, which keeps the two independent.
//
// Errors and health get CACHE_NONE: a cached 503 would outlive the Aura outage
// that caused it. Next emits no Cache-Control at all on those responses
// (measured), so the directive has to be explicit rather than left to a default.
const HOUR = 3600;
const DAY = 24 * HOUR;

function cdnCache(sMaxAge: number, staleWhileRevalidate: number) {
  return {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
  };
}

export const CACHE_STABLE = cdnCache(DAY, 7 * DAY);

// Search takes an arbitrary string, so its URL space never concentrates enough
// to justify holding entries for a day.
export const CACHE_VOLATILE = cdnCache(HOUR, DAY);

export const CACHE_NONE = { "Cache-Control": "no-store" } as const;

// Log details server-side but return a generic 503 so internal info
// (connection URI, auth errors, stack) is not leaked to clients.
export function serviceUnavailable(
  context: string,
  err: unknown,
): NextResponse {
  console.error(`${context}:`, err);
  return NextResponse.json(
    { status: "error", message: "Service unavailable" },
    { status: 503, headers: CACHE_NONE },
  );
}
