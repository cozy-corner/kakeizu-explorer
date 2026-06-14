import neo4j, { type Driver } from "neo4j-driver";

// A Driver owns a connection pool, so create exactly one per process.
// Cache it on globalThis so it isn't recreated when the module is re-evaluated
// (dev hot reload / serverless instance reuse) — same pattern as Prisma etc.
const globalForNeo4j = globalThis as unknown as { _neo4jDriver?: Driver };

export function getDriver(): Driver {
  if (!globalForNeo4j._neo4jDriver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      throw new Error(
        "Missing env vars: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD",
      );
    }
    globalForNeo4j._neo4jDriver = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password),
    );
  }
  return globalForNeo4j._neo4jDriver;
}
