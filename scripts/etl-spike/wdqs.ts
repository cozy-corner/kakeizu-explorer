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

// Wikidata entity URI (http://www.wikidata.org/entity/Q123) → bare Q-id; binding
// values come back as full URIs.
export const qid = (uri: string) =>
  uri.replace("http://www.wikidata.org/entity/", "");

// SPARQL VALUES list body from bare Q-ids: `wd:Q1 wd:Q2 …`.
export const sparqlValues = (qids: string[]) =>
  qids.map((q) => `wd:${q}`).join(" ");

// Split into fixed-size batches so a VALUES list stays under the WDQS timeout.
export const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const CACHE_DIR = join(import.meta.dirname, "data", ".cache");
const CACHE_ENABLED = process.env.WDQS_NOCACHE !== "1";
// Cap concurrent in-flight WDQS requests (issue #16). Callers may Promise.all
// freely; this gate — not the call sites — bounds how hard we hit the shared
// public endpoint. Kept modest (2–4) to avoid inducing 429/504.
const MAX_CONCURRENCY = Number(process.env.WDQS_CONCURRENCY ?? "3");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with full jitter: random delay in [0, base*2^attempt].
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

// Global concurrency gate: at most MAX_CONCURRENCY requests run at once. release
// hands its slot directly to the next waiter, so `active` never dips between a
// release and the resumed acquire.
let active = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
}
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

// Shared cooperative backoff (issue #16): when one request hits 429/5xx, every
// other in-flight worker must also stand down — otherwise the pool keeps
// hammering a throttling server. A request records how long to pause here; all
// workers await it before their next attempt, so N parallel workers behave like
// one polite client under throttling.
let pausedUntil = 0;
async function respectSharedPause(): Promise<void> {
  const wait = pausedUntil - Date.now();
  if (wait > 0) await sleep(wait);
}
function sharedPause(ms: number): void {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
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
    // Stand down if a sibling worker hit throttling — parallel workers must
    // pause together, not race ahead while WDQS is asking us to wait.
    await respectSharedPause();

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

    // 4xx other than 429: permanent, fail fast. (A 2xx/3xx is `res.ok` here for
    // 2xx and falls through to the parse below; the `!res.ok` guard keeps this
    // from throwing on a successful response.)
    if (!res.ok && res.status < 500 && res.status !== 429) {
      throw new Error(
        `WDQS ${res.status}: ${(await res.text()).slice(0, 160)}`,
      );
    }

    // 5xx or 429: transient. Pause the whole pool (honoring Retry-After) so
    // in-flight siblings don't pile more requests onto a throttling server.
    if (!res.ok) {
      lastError = new Error(`WDQS ${res.status}`);
      const delay =
        parseRetryAfter(res.headers.get("retry-after")) ??
        backoffDelay(attempt);
      sharedPause(delay);
      if (attempt < MAX_ATTEMPTS - 1) await sleep(delay);
      continue;
    }

    // Read + parse INSIDE a try: a 200 with a truncated/broken body (WDQS
    // truncation under load, or a mid-stream disconnect) makes JSON.parse throw.
    // Formerly this sat outside the retry loop, so one bad body killed the whole
    // ETL — and parallelism makes large concurrent responses (the fragile ones)
    // more frequent, so it would drop every in-flight sibling too. Now transient.
    try {
      const text = await res.text();
      return (JSON.parse(text) as { results: { bindings: Binding[] } }).results
        .bindings;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      break;
    }
  }
  throw new Error(
    `WDQS request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

// Run `request` under the global concurrency gate. Cache hits skip this — they
// touch no network, so they shouldn't consume a slot.
async function gatedRequest(query: string): Promise<Binding[]> {
  await acquire();
  try {
    return await request(query);
  } finally {
    release();
  }
}

export async function sparql(query: string): Promise<Binding[]> {
  if (!CACHE_ENABLED) return gatedRequest(query);
  const path = cachePath(query);
  const cached = await cacheGet(path);
  if (cached) return cached;
  const data = await gatedRequest(query);
  await cachePut(path, data);
  return data;
}
