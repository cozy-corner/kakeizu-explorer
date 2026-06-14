import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";

// Hits the DB at request time, so opt out of static optimization (build-time execution).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // getDriver() can throw (missing env), so keep it inside try — otherwise the
    // throw escapes the catch below and surfaces as a 500 instead of 503.
    const session = getDriver().session();
    try {
      const result = await session.run("RETURN 1 AS ok");
      const ok = result.records[0]?.get("ok");
      return NextResponse.json({
        status: "ok",
        neo4j: typeof ok?.toNumber === "function" ? ok.toNumber() : ok,
      });
    } finally {
      await session.close();
    }
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
