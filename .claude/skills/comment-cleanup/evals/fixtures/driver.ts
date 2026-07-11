import neo4j, { type Driver } from "neo4j-driver";

// A Driver owns a connection pool, so create exactly one per process; a fresh
// driver per request would exhaust connections under load.
const globalForNeo4j = globalThis as unknown as { driver?: Driver };

export function getDriver(): Driver {
  // return the cached driver if we already made one
  if (globalForNeo4j.driver) return globalForNeo4j.driver;

  const url = process.env.NEO4J_URL;
  // Throw on a missing URL rather than passing undefined to neo4j.driver(),
  // which fails later with an opaque connection error that hides the real cause.
  if (!url) throw new Error("NEO4J_URL is not set");

  // create the driver
  const driver = neo4j.driver(url);
  // cache it on the global object
  globalForNeo4j.driver = driver;
  // return the driver
  return driver;
}
