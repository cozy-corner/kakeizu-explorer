import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";

// Hits the DB at request time, so opt out of static optimization (build-time execution).
export const dynamic = "force-dynamic";

export async function GET() {
  const session = getDriver().session();
  try {
    const result = await session.run("RETURN 1 AS ok");
    const ok = result.records[0]?.get("ok");
    return NextResponse.json({
      status: "ok",
      neo4j: typeof ok?.toNumber === "function" ? ok.toNumber() : ok,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  } finally {
    await session.close();
  }
}
