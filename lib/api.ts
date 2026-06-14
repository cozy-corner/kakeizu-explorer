import { type Record as Neo4jRecord } from "neo4j-driver";
import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";

// Run a Cypher query against the shared driver and always close the session.
// getDriver() can throw (missing env); that surfaces here so callers can funnel
// it through serviceUnavailable() instead of leaking a 500.
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

// Log details server-side but return a generic 503 so internal info
// (connection URI, auth errors, stack) is not leaked to clients.
export function serviceUnavailable(
  context: string,
  err: unknown,
): NextResponse {
  console.error(`${context}:`, err);
  return NextResponse.json(
    { status: "error", message: "Service unavailable" },
    { status: 503 },
  );
}
