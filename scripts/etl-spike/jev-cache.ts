// Jev cache: load probe-jev output and answer "is this qid clearly non-Japanese?"
// for stateless nodes. Stateless nodes are currently kept as bridges (see
// traverse.ts isForeign) because medieval Japanese often lack citizenship tags.
// The cache lets traverse prune the *foreign* stateless slice (kana-only
// drift candidates in the kana case) without slowing traversal with synchronous
// Jev calls.
//
// Data shape: reads {summary, samples:[{qid, label, kind, probability, ...}]}
// produced by `bun probe-jev.ts --mode probe-stateless`.

import { readFile } from "node:fs/promises";

export type JevEntry = {
  label: string;
  kind: string;
  probability: number;
};

export type JevCache = {
  scope: string;
  model: string;
  byQid: Map<string, JevEntry>;
};

let cache: JevCache | null = null;

export async function loadJevCache(path: string): Promise<JevCache | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const data = JSON.parse(raw) as {
    summary?: { scope?: string; model?: string };
    samples?: Array<{
      qid?: string;
      label?: string;
      kind?: string;
      probability?: number | null;
    }>;
  };
  const byQid = new Map<string, JevEntry>();
  for (const s of data.samples ?? []) {
    if (typeof s.qid !== "string" || typeof s.probability !== "number")
      continue;
    byQid.set(s.qid, {
      label: s.label ?? "",
      kind: s.kind ?? "",
      probability: s.probability,
    });
  }
  cache = {
    scope: data.summary?.scope ?? "?",
    model: data.summary?.model ?? "?",
    byQid,
  };
  return cache;
}

// High-confidence non-Japanese: probability strictly below threshold. Below 0.5
// the Jev model answers "no" with high confidence; using a tighter bound (e.g.
// 0.30) leaves the ambiguous 0.3-0.5 band as bridges to avoid losing real
// Japanese borderline cases (ancient names, placeholders).
export function jevClearlyForeign(
  qid: string,
  threshold: number,
): boolean | null {
  if (!cache) return null;
  const e = cache.byQid.get(qid);
  if (!e) return null;
  return e.probability < threshold;
}
