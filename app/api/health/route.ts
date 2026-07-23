import { NextResponse } from "next/server";
import { runQuery, serviceUnavailable } from "@/lib/api";

// Hits the DB at request time, so opt out of static optimization.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [ok] = await runQuery("RETURN 1 AS ok", {}, (r) => {
      const v = r.get("ok");
      return typeof v?.toNumber === "function" ? v.toNumber() : v;
    });
    return NextResponse.json({ status: "ok", neo4j: ok });
  } catch (err) {
    return serviceUnavailable("Health check failed", err);
  }
}
