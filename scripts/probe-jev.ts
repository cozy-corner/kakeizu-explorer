#!/usr/bin/env bun
// Probe: drop Jev requests and log the response shape.
//
// Modes:
//   (default)              single request, dump raw response
//   --mode rate-limit      send up to N requests at I-ms interval, stop on first 429
//   --mode probe-list      read a JSONL of names, one Jev request per row
//   --mode probe-stateless read scripts/etl-spike/data/raw-nodes.json, filter to
//                          nodes with no citizenship tag, ask Jev for each
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

// --in / --out may be absolute, or relative to the repo root (so the worktree
// and a checkout at a different path behave the same).
const REPO_ROOT = join(import.meta.dirname, "..");
function resolveRepoPath(p: string): string {
  return p.startsWith("/") ? p : join(REPO_ROOT, p);
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

  const outAbs = resolveRepoPath(OUT_REL);
  await writeFile(outAbs, JSON.stringify({ summary, samples }, null, 2));
  console.log(`wrote ${OUT_REL}`);
  process.exit(0);
}

if (MODE === "probe-list") {
  const IN_REL = flags.get("in");
  if (!IN_REL) {
    console.error("--in <path> is required for --mode probe-list");
    process.exit(2);
  }
  const INTERVAL_MS = Number(flags.get("interval-ms") ?? "1000");
  const OUT_REL = flags.get("out") ?? "scripts/probe-jev.probe-list.json";
  const THRESHOLD = Number(flags.get("threshold") ?? "0.5");
  if (!Number.isFinite(THRESHOLD) || THRESHOLD < 0 || THRESHOLD > 1) {
    console.error(
      `--threshold must be in [0, 1], got ${flags.get("threshold")}`,
    );
    process.exit(2);
  }

  // JSONL: one row per line, {"label": "name", "expected": "jp"|"non-jp"|"unknown"}.
  // Lines starting with "#" and blank lines are ignored.
  const inAbs = resolveRepoPath(IN_REL);
  const text = await readFile(inAbs, "utf8");
  type Row = { line: number; label: string; expected: string };
  const rows: Row[] = [];
  for (let i = 0; i < text.split("\n").length; i++) {
    const raw = text.split("\n")[i];
    if (!raw.trim() || raw.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `${inAbs}:${i + 1}: invalid JSON: ${(err as Error).message}`,
      );
      process.exit(2);
    }
    const obj = parsed as { label?: unknown; expected?: unknown };
    if (typeof obj.label !== "string" || !obj.label) {
      console.error(`${inAbs}:${i + 1}: missing "label"`);
      process.exit(2);
    }
    rows.push({
      line: i + 1,
      label: obj.label,
      expected: typeof obj.expected === "string" ? obj.expected : "unknown",
    });
  }

  type Sample = {
    line: number;
    label: string;
    expected: string;
    status: number;
    elapsedMs: number;
    japanese: boolean | null;
    probability: number | null;
    raw: unknown;
    retryAfterHeader: string | null;
    error: string | null;
  };
  const samples: Sample[] = [];
  let first429: {
    line: number;
    label: string;
    retryAfterHeader: string | null;
    retryAfterMs: number | null;
  } | null = null;
  let stopReason: "count" | "first-429" | "error" = "count";
  let lastError: string | null = null;

  const start = performance.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t0 = performance.now();
    let sample: Sample;
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(buildBody(MODEL, row.label)),
      });
      const retryHeader = r.headers.get("retry-after");
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave parsed as null
      }
      const isJp = (
        parsed as { answers?: { is_jp?: { noul?: number } } } | null
      )?.answers?.is_jp;
      const probability = typeof isJp?.noul === "number" ? isJp.noul : null;
      const japanese = probability === null ? null : probability >= THRESHOLD;
      sample = {
        line: row.line,
        label: row.label,
        expected: row.expected,
        status: r.status,
        elapsedMs: Math.round(performance.now() - t0),
        japanese,
        probability,
        raw: parsed,
        retryAfterHeader: retryHeader,
        error: null,
      };
    } catch (err) {
      lastError = (err as Error).message;
      sample = {
        line: row.line,
        label: row.label,
        expected: row.expected,
        status: 0,
        elapsedMs: Math.round(performance.now() - t0),
        japanese: null,
        probability: null,
        raw: null,
        retryAfterHeader: null,
        error: lastError,
      };
      samples.push(sample);
      stopReason = "error";
      break;
    }
    samples.push(sample);
    console.log(
      `row ${i + 1}/${rows.length} line=${row.line} label=${row.label} status=${sample.status} prob=${sample.probability ?? "-"} japanese=${sample.japanese ?? "-"} elapsed=${sample.elapsedMs}ms`,
    );
    if (sample.status === 429) {
      first429 = {
        line: row.line,
        label: row.label,
        retryAfterHeader: sample.retryAfterHeader,
        retryAfterMs: parseRetryAfterMs(sample.retryAfterHeader),
      };
      stopReason = "first-429";
      break;
    }
    if (i + 1 < rows.length) {
      const remaining = INTERVAL_MS - sample.elapsedMs;
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
  }
  const totalMs = Math.round(performance.now() - start);

  // Aggregate accuracy by expected label. "unknown" rows are reported but not
  // scored (no ground truth).
  type Bucket = {
    n: number;
    japaneseYes: number;
    japaneseNo: number;
    errors: number;
  };
  const byExpected: Record<string, Bucket> = {};
  for (const s of samples) {
    const b = (byExpected[s.expected] ??= {
      n: 0,
      japaneseYes: 0,
      japaneseNo: 0,
      errors: 0,
    });
    b.n++;
    if (s.error || s.japanese === null) b.errors++;
    else if (s.japanese) b.japaneseYes++;
    else b.japaneseNo++;
  }
  // For "jp" expected, "yes" is correct; for "non-jp", "no" is correct.
  const control = ["jp", "non-jp"] as const;
  const correct = (b: Bucket | undefined, label: string) => {
    if (!b) return 0;
    return label === "jp" ? b.japaneseYes : b.japaneseNo;
  };
  const controlN = control.reduce((acc, k) => acc + (byExpected[k]?.n ?? 0), 0);
  const controlCorrect = control.reduce(
    (acc, k) => acc + correct(byExpected[k], k),
    0,
  );

  const summary = {
    mode: "probe-list",
    model: MODEL,
    threshold: THRESHOLD,
    inputFile: IN_REL,
    total: rows.length,
    completed: samples.length,
    stopReason,
    first429,
    lastError,
    totalMs,
    controlN,
    controlCorrect,
    controlAccuracy: controlN ? controlCorrect / controlN : null,
    byExpected,
  };
  console.log("--- summary ---");
  console.log(JSON.stringify(summary, null, 2));

  const outAbs = resolveRepoPath(OUT_REL);
  await writeFile(outAbs, JSON.stringify({ summary, samples }, null, 2));
  console.log(`wrote ${OUT_REL}`);
  process.exit(0);
}

if (MODE === "probe-stateless") {
  // Read raw-nodes.json, filter to nodes with no citizenship tag, ask Jev.
  // Default scope: kana-only stateless (the highest-signal drift slice).
  const SCOPE = flags.get("scope") ?? "kana";
  const OUT_REL = flags.get("out") ?? "scripts/jev-stateless.json";
  const INTERVAL_MS = Number(flags.get("interval-ms") ?? "1000");
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 0) {
    console.error(
      `--interval-ms must be a non-negative number, got ${flags.get("interval-ms")}`,
    );
    process.exit(2);
  }

  const KANJI = /\p{Script=Han}/u;
  const KANA = /\p{Script=Katakana}|\p{Script=Hiragana}/u;
  const LATIN = /[A-Za-z]/u;
  function scriptKind(
    label: string,
  ): "kanji" | "kana" | "latin" | "kanji+kana" | "mixed" | "other" {
    const hasKanji = KANJI.test(label);
    const hasKana = KANA.test(label);
    const hasLatin = LATIN.test(label);
    if (hasKanji && !hasKana && !hasLatin) return "kanji";
    if (hasKana && !hasKanji) return "kana";
    if (hasLatin && !hasKanji && !hasKana) return "latin";
    if (hasKanji && hasKana) return "kanji+kana";
    if (hasLatin && (hasKanji || hasKana)) return "mixed";
    return "other";
  }

  type RawNode = {
    qid: string;
    label: string;
    nationalities?: string[];
    nationalityCountries?: string[];
  };
  const rawPath = resolveRepoPath("scripts/etl-spike/data/raw-nodes.json");
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as RawNode[];

  const stateless = raw.filter(
    (n) =>
      (!n.nationalities || n.nationalities.length === 0) &&
      (!n.nationalityCountries || n.nationalityCountries.length === 0),
  );

  const scopeFilter = (n: RawNode): boolean => {
    const k = scriptKind(n.label);
    if (SCOPE === "kana") return k === "kana";
    if (SCOPE === "latin") return k === "latin";
    if (SCOPE === "all") return true;
    console.error(`--scope must be kana|latin|all, got ${SCOPE}`);
    process.exit(2);
  };
  const picked = stateless.filter(scopeFilter);

  type Sample = {
    qid: string;
    label: string;
    kind: string;
    status: number;
    elapsedMs: number;
    japanese: boolean | null;
    probability: number | null;
    raw: unknown;
    retryAfterHeader: string | null;
    error: string | null;
  };
  const samples: Sample[] = [];
  let first429: {
    qid: string;
    label: string;
    retryAfterHeader: string | null;
    retryAfterMs: number | null;
  } | null = null;
  let stopReason: "count" | "first-429" | "error" = "count";
  let lastError: string | null = null;

  const start = performance.now();
  for (let i = 0; i < picked.length; i++) {
    const row = picked[i];
    const t0 = performance.now();
    let sample: Sample;
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(buildBody(MODEL, row.label)),
      });
      const retryHeader = r.headers.get("retry-after");
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave parsed as null
      }
      const isJp = (
        parsed as { answers?: { is_jp?: { noul?: number } } } | null
      )?.answers?.is_jp;
      const probability = typeof isJp?.noul === "number" ? isJp.noul : null;
      const japanese = probability === null ? null : probability >= 0.5;
      sample = {
        qid: row.qid,
        label: row.label,
        kind: scriptKind(row.label),
        status: r.status,
        elapsedMs: Math.round(performance.now() - t0),
        japanese,
        probability,
        raw: parsed,
        retryAfterHeader: retryHeader,
        error: null,
      };
    } catch (err) {
      lastError = (err as Error).message;
      sample = {
        qid: row.qid,
        label: row.label,
        kind: scriptKind(row.label),
        status: 0,
        elapsedMs: Math.round(performance.now() - t0),
        japanese: null,
        probability: null,
        raw: null,
        retryAfterHeader: null,
        error: lastError,
      };
      samples.push(sample);
      stopReason = "error";
      break;
    }
    samples.push(sample);
    console.log(
      `row ${i + 1}/${picked.length} qid=${row.qid} label=${row.label} kind=${sample.kind} status=${sample.status} prob=${sample.probability ?? "-"} japanese=${sample.japanese ?? "-"} elapsed=${sample.elapsedMs}ms`,
    );
    if (sample.status === 429) {
      first429 = {
        qid: row.qid,
        label: row.label,
        retryAfterHeader: sample.retryAfterHeader,
        retryAfterMs: parseRetryAfterMs(sample.retryAfterHeader),
      };
      stopReason = "first-429";
      break;
    }
    if (i + 1 < picked.length) {
      const remaining = INTERVAL_MS - sample.elapsedMs;
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
  }
  const totalMs = Math.round(performance.now() - start);

  // No ground truth for stateless; bucket by kind + decision for inspection.
  const kindCounts: Record<
    string,
    { n: number; jp: number; nonjp: number; err: number }
  > = {};
  for (const s of samples) {
    const b = (kindCounts[s.kind] ??= { n: 0, jp: 0, nonjp: 0, err: 0 });
    b.n++;
    if (s.error || s.japanese === null) b.err++;
    else if (s.japanese) b.jp++;
    else b.nonjp++;
  }

  const summary = {
    mode: "probe-stateless",
    model: MODEL,
    scope: SCOPE,
    statelessTotal: stateless.length,
    picked: picked.length,
    completed: samples.length,
    stopReason,
    first429,
    lastError,
    totalMs,
    kindCounts,
  };
  console.log("--- summary ---");
  console.log(JSON.stringify(summary, null, 2));

  const outAbs = resolveRepoPath(OUT_REL);
  await writeFile(outAbs, JSON.stringify({ summary, samples }, null, 2));
  console.log(`wrote ${OUT_REL}`);
  process.exit(0);
}

console.error(
  `unknown --mode: ${MODE} (expected: single | rate-limit | probe-list | probe-stateless)`,
);
process.exit(2);
