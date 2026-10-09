#!/usr/bin/env bun
// Probe: drop Jev requests and log the response shape.
//
// Modes:
//   (default)        single request, dump raw response
//   --mode rate-limit  send up to N requests at I-ms interval, stop on first 429
//
// Auth: OPENCODE_JEV_API_KEY. If absent from process.env, fall back to reading
// it from .env.local — `bun run` alone doesn't auto-load that file, and dotenv
// is overkill for one var.
//
// In --mode rate-limit, response bodies and the Authorization header are NOT
// printed or persisted — only status, elapsed, and Retry-After are recorded.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const URL = "https://opencode.ai/zen/v1/systemone";
const DEFAULT_MODEL = "jev-1.13-free";
const DEFAULT_STATE = "徳川家康";

async function readEnvLocal(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await readFile(
      join(import.meta.dirname, "..", ".env.local"),
      "utf8",
    );
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // No .env.local — caller will report missing key.
  }
  return out;
}

const fromFile = process.env.OPENCODE_JEV_API_KEY ? null : await readEnvLocal();
const KEY = process.env.OPENCODE_JEV_API_KEY ?? fromFile?.OPENCODE_JEV_API_KEY;
if (!KEY) {
  console.error("OPENCODE_JEV_API_KEY is not set");
  process.exit(1);
}

// --- CLI parsing -----------------------------------------------------------
// Accepts --flag value and --flag=value. Positional args are kept for the
// single-shot default so `bun probe-jev.ts <state> <model>` still works.
const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags.set(a.slice(2), args[i + 1]);
      i++;
    } else {
      flags.set(a.slice(2), "true");
    }
  } else {
    positional.push(a);
  }
}

const MODE = flags.get("mode") ?? "single";
const STATE = positional[0] ?? DEFAULT_STATE;
const MODEL = positional[1] ?? DEFAULT_MODEL;

function buildBody(model: string, state: string) {
  return {
    model,
    state,
    questions: {
      is_jp: {
        type: "noul" as const,
        instructions: "Is this name that of a Japanese person?",
      },
    },
  };
}

const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "User-Agent": "kakeizu-probe/1.0 (kakeizu-explorer Jev probe)",
} as const;

// Retry-After is either delta-seconds or an HTTP-date; returns ms, or null.
// Mirrors scripts/etl-spike/wdqs.ts so a future client-side backoff can share.
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

if (MODE === "single") {
  const t0 = performance.now();
  const r = await fetch(URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(buildBody(MODEL, STATE)),
  });
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

  console.log(`POST ${URL}`);
  console.log(`model: ${MODEL}, state: ${STATE}`);
  console.log(`status: ${r.status} (${elapsed}s)`);
  console.log(`content-type: ${r.headers.get("content-type")}`);
  console.log("--- response body ---");
  console.log(await r.text());
  process.exit(0);
}

if (MODE === "rate-limit") {
  const COUNT = Number(flags.get("count") ?? "120");
  const INTERVAL_MS = Number(flags.get("interval-ms") ?? "1000");
  const STATE_RL = flags.get("state") ?? STATE;
  const OUT_REL = flags.get("out") ?? "scripts/probe-jev.rate-limit.json";
  if (!Number.isFinite(COUNT) || COUNT <= 0) {
    console.error(
      `--count must be a positive number, got ${flags.get("count")}`,
    );
    process.exit(2);
  }
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 0) {
    console.error(
      `--interval-ms must be a non-negative number, got ${flags.get("interval-ms")}`,
    );
    process.exit(2);
  }

  type Sample = {
    i: number;
    status: number;
    elapsedMs: number;
    retryAfterHeader: string | null;
    retryAfterMs: number | null;
  };
  const samples: Sample[] = [];
  let first429: Sample | null = null;
  let stopReason: "count" | "first-429" | "error" = "count";
  let lastError: string | null = null;

  const start = performance.now();
  for (let i = 1; i <= COUNT; i++) {
    const t0 = performance.now();
    let sample: Sample;
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(buildBody(MODEL, STATE_RL)),
      });
      const header = r.headers.get("retry-after");
      // Read body but discard — never log or persist it in this mode.
      await r.text();
      sample = {
        i,
        status: r.status,
        elapsedMs: Math.round(performance.now() - t0),
        retryAfterHeader: header,
        retryAfterMs: parseRetryAfterMs(header),
      };
    } catch (err) {
      lastError = (err as Error).message;
      sample = {
        i,
        status: 0,
        elapsedMs: Math.round(performance.now() - t0),
        retryAfterHeader: null,
        retryAfterMs: null,
      };
      samples.push(sample);
      stopReason = "error";
      break;
    }
    samples.push(sample);
    console.log(
      `req ${i}/${COUNT}: status=${sample.status} elapsed=${sample.elapsedMs}ms retry-after=${sample.retryAfterHeader ?? "-"}`,
    );
    if (sample.status === 429) {
      first429 = sample;
      stopReason = "first-429";
      break;
    }
    if (i < COUNT) {
      const remaining = INTERVAL_MS - sample.elapsedMs;
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
  }
  const totalMs = Math.round(performance.now() - start);

  const statusCounts = samples.reduce<Record<string, number>>((acc, s) => {
    const k = String(s.status);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const summary = {
    mode: "rate-limit",
    model: MODEL,
    state: STATE_RL,
    requestedCount: COUNT,
    intervalMs: INTERVAL_MS,
    sent: samples.length,
    first429: first429
      ? {
          at: first429.i,
          retryAfterHeader: first429.retryAfterHeader,
          retryAfterMs: first429.retryAfterMs,
        }
      : null,
    stopReason,
    lastError,
    totalMs,
    statusCounts,
  };
  console.log("--- summary ---");
  console.log(JSON.stringify(summary, null, 2));

  const repoRoot = join(import.meta.dirname, "..");
  const outAbs = OUT_REL.startsWith("/") ? OUT_REL : join(repoRoot, OUT_REL);
  await writeFile(outAbs, JSON.stringify({ summary, samples }, null, 2));
  console.log(`wrote ${OUT_REL}`);
  process.exit(0);
}

console.error(`unknown --mode: ${MODE} (expected: single | rate-limit)`);
process.exit(2);
