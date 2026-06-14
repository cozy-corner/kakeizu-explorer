// Polite Wikidata Query Service (WDQS) client shared by the ETL spike scripts.
//
// Retry etiquette (general best practice for a shared public endpoint):
//  - retry ONLY transient failures: network exceptions, HTTP 5xx, and 429
//  - never retry other 4xx (bad query / 431) — a retry won't fix them
//  - honor the server's Retry-After header when present (most important manner)
//  - otherwise exponential backoff (base 1s, ×2, capped) with full jitter
//  - cap total attempts
//  - identify ourselves with a descriptive User-Agent (WDQS requirement)
//  - POST so long VALUES lists don't overflow the URL (HTTP 431)
//
// Result cache: every successful query is memoized to data/.cache/<sha1>.json,
// keyed by the exact query string. Re-runs (e.g. after a transient 504) replay
// cached queries instantly and never re-hit WDQS for data already fetched.
// Disable with WDQS_NOCACHE=1.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ENDPOINT = "https://query.wikidata.org/sparql";
export const USER_AGENT =
  "kakeizu-explorer-spike/0.1 (https://github.com/cozy-corner/kakeizu-explorer; sasakicozy@gmail.com)";

export type Binding = Record<string, { value: string } | undefined>;

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const CACHE_DIR = join(import.meta.dirname, "data", ".cache");
const CACHE_ENABLED = process.env.WDQS_NOCACHE !== "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with full jitter: random delay in [0, base*2^attempt].
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

// Retry-After is either delta-seconds or an HTTP-date; returns ms, or null.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

function cachePath(query: string): string {
  const key = createHash("sha1").update(query).digest("hex");
  return join(CACHE_DIR, `${key}.json`);
}

async function cacheGet(path: string): Promise<Binding[] | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Binding[];
  } catch {
    return null; // cache miss (file absent / unreadable)
  }
}

async function cachePut(path: string, data: Binding[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

async function request(query: string): Promise<Binding[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `query=${encodeURIComponent(query)}`,
      });
    } catch (err) {
      // Network-level failure (connection reset, DNS, etc.) — transient.
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      break;
    }

    if (res.ok) {
      const json = (await res.json()) as { results: { bindings: Binding[] } };
      return json.results.bindings;
    }

    // 4xx other than 429: permanent, fail fast.
    if (res.status < 500 && res.status !== 429) {
      throw new Error(
        `WDQS ${res.status}: ${(await res.text()).slice(0, 160)}`,
      );
    }

    // 5xx or 429: transient, back off (honoring Retry-After) and retry.
    lastError = new Error(`WDQS ${res.status}`);
    if (attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      await sleep(retryAfter ?? backoffDelay(attempt));
    }
  }
  throw new Error(
    `WDQS request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

export async function sparql(query: string): Promise<Binding[]> {
  if (!CACHE_ENABLED) return request(query);
  const path = cachePath(query);
  const cached = await cacheGet(path);
  if (cached) return cached;
  const data = await request(query);
  await cachePut(path, data);
  return data;
}
