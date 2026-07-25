// Diagnostic spike: size the "Wikipedia says parent/child, but the graph doesn't
// show it" gap, and split it into the two sub-cases that need different fixes.
//
// For a random sample of graph nodes that have a ja.wikipedia article, read each
// article's infobox 父/母/子 fields, resolve the linked people to Wikidata items,
// and classify every asserted blood parent-child relation:
//
//   connected        — edge already in the graph (parent_of / adopted_of). fine.
//   missing-edge      — relative IS a graph node, but no edge joins them.
//                       => Wikidata lacks the P22/P25/P40 statement; ADDING THE
//                          EDGE is the easy win (both items already exist & load).
//   not-in-graph      — relative HAS a Wikidata item, but it's not a graph node
//                       (pruned as foreign, or never reached). different fix.
//   no-item           — the infobox link is a redlink / has no Wikidata item.
//                       => needs a NEW item first (the hard, name-matching case).
//
// Data source = the loaded ETL output (scripts/etl-spike/data/*.json).
// Network = MediaWiki APIs only (Wikidata wbgetentities for QID→ja title, and
// ja.wikipedia query for wikitext + link→wikibase_item). No WDQS.
//
// Usage: bun run scripts/wiki-vs-graph-gap.ts [--sample N] [--seed S]

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA = join(import.meta.dirname, "etl-spike", "data");
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const JAWIKI_API = "https://ja.wikipedia.org/w/api.php";
const UA =
  "kakeizu-explorer-spike/0.1 (https://github.com/cozy-corner/kakeizu-explorer; sasakicozy@gmail.com)";

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const SAMPLE = flag("--sample", 400);
const SEED = flag("--seed", 42);

// --- graph side -------------------------------------------------------------
interface Node {
  qid: string;
  label: string;
}
interface Edge {
  from: string;
  to: string;
}
const readJson = async <T>(f: string): Promise<T> =>
  JSON.parse(await readFile(join(DATA, f), "utf8")) as T;

const nodes = await readJson<Node[]>("nodes.json");
const parentEdges = await readJson<Edge[]>("parent_of.json");
const adoptEdges = await readJson<Edge[]>("adopted_of.json");

const graphQids = new Set(nodes.map((n) => n.qid));
const labelOf = new Map(nodes.map((n) => [n.qid, n.label]));
// edge key "parent->child"; both blood and adoptive count as "connected".
const edgeKeys = new Set(
  [...parentEdges, ...adoptEdges].map((e) => `${e.from}->${e.to}`),
);

// --- deterministic sample (seeded LCG; Math.random would drift run-to-run) ---
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function sample<T>(arr: T[], n: number, seed: number): T[] {
  const rng = lcg(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
const focusQids = sample(
  nodes.map((n) => n.qid),
  SAMPLE,
  SEED,
);

// --- MediaWiki client -------------------------------------------------------
const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
// Only the fields this probe reads; every branch is optional since the two APIs
// (wbgetentities, query) return different subsets.
interface MwPage {
  title?: string;
  revisions?: { slots?: { main?: { "*"?: string } } }[];
  pageprops?: { wikibase_item?: string };
}
interface MwResponse {
  entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }>;
  query?: {
    pages?: Record<string, MwPage>;
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
  };
}
async function mwGet(
  base: string,
  params: Record<string, string>,
): Promise<MwResponse> {
  const url = `${base}?${new URLSearchParams({ ...params, format: "json", origin: "*" })}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as MwResponse;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}

// QID -> ja.wikipedia article title (only for items that have one).
async function jaTitles(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const b of chunk(qids, 50)) {
    const data = await mwGet(WIKIDATA_API, {
      action: "wbgetentities",
      ids: b.join("|"),
      props: "sitelinks",
      sitefilter: "jawiki",
    });
    for (const [qid, ent] of Object.entries(data.entities ?? {})) {
      const t = ent?.sitelinks?.jawiki?.title;
      if (t) out.set(qid, t);
    }
  }
  return out;
}

// ja article title -> wikitext of the current revision.
async function wikitext(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const b of chunk(titles, 50)) {
    const data = await mwGet(JAWIKI_API, {
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: b.join("|"),
      redirects: "1",
    });
    const pages = data.query?.pages ?? {};
    // Map back through normalized/redirect aliases so we key by the title we asked for.
    const alias = new Map<string, string>();
    for (const n of data.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of data.query?.redirects ?? []) alias.set(r.from, r.to);
    const resolve = (t: string) => {
      let cur = t;
      for (let i = 0; i < 5 && alias.has(cur); i++) cur = alias.get(cur)!;
      return cur;
    };
    const byTitle = new Map<string, string>();
    for (const p of Object.values(pages)) {
      const text = p?.revisions?.[0]?.slots?.main?.["*"];
      if (p?.title && text) byTitle.set(p.title, text);
    }
    for (const asked of b) {
      const text = byTitle.get(resolve(asked));
      if (text) out.set(asked, text);
    }
  }
  return out;
}

// ja article title -> wikibase_item QID (missing/redlink -> absent).
async function titleToQid(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(titles)];
  for (const b of chunk(uniq, 50)) {
    const data = await mwGet(JAWIKI_API, {
      action: "query",
      prop: "pageprops",
      ppprop: "wikibase_item",
      titles: b.join("|"),
      redirects: "1",
    });
    const alias = new Map<string, string>();
    for (const n of data.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of data.query?.redirects ?? []) alias.set(r.from, r.to);
    const resolve = (t: string) => {
      let cur = t;
      for (let i = 0; i < 5 && alias.has(cur); i++) cur = alias.get(cur)!;
      return cur;
    };
    const byTitle = new Map<string, string>();
    for (const p of Object.values(data.query?.pages ?? {})) {
      const q = p?.pageprops?.wikibase_item;
      if (p?.title && q) byTitle.set(p.title, q);
    }
    for (const asked of b) {
      const q = byTitle.get(resolve(asked));
      if (q) out.set(asked, q);
    }
  }
  return out;
}

// --- infobox parsing --------------------------------------------------------
// Blood parent/child fields (father/mother/child variants). Adoptive fields are
// excluded — this measures the blood-descent gap the graph draws.
const PARENT_FIELD = /^(父|母|父親|母親)$/;
const CHILD_FIELD = /^(子|子女|子供|子女たち|息子|娘)$/;

// Read the balanced {{…}} template that starts at index `start`; return its inner
// body and the index just past the closing "}}". Depth-aware so nested templates
// don't end it early.
function readTemplate(
  wt: string,
  start: number,
): { body: string; end: number } {
  let depth = 0;
  let i = start;
  for (; i < wt.length; i++) {
    if (wt[i] === "{" && wt[i + 1] === "{") {
      depth++;
      i++;
    } else if (wt[i] === "}" && wt[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return { body: wt.slice(start + 2, i - 2), end: i };
}

// Split a template body on top-level "|" only — pipes inside nested {{…}} or
// [[…]] belong to those and must not split a field.
function splitTopLevel(body: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      i++;
    } else if (two === "}}" || two === "]]") {
      depth--;
      i++;
    } else if (body[i] === "|" && depth === 0) {
      segs.push(body.slice(last, i));
      last = i + 1;
    }
  }
  segs.push(body.slice(last));
  return segs;
}

// "name = value" fields across every top-level template. Each field value is
// bounded by the template, so it can't bleed into the article body.
function infoboxFields(wt: string): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  for (let i = 0; i < wt.length; i++) {
    if (wt[i] !== "{" || wt[i + 1] !== "{") continue;
    const { body, end } = readTemplate(wt, i);
    i = end - 1;
    const segs = splitTopLevel(body).slice(1); // [0] is the template name
    for (const seg of segs) {
      const eq = seg.indexOf("=");
      if (eq < 0) continue;
      const field = seg.slice(0, eq).trim();
      if (field.length > 8 || field.includes("\n")) continue;
      out.push({ field, value: seg.slice(eq + 1) });
    }
  }
  return out;
}

// Extract [[Target]] / [[Target|label]] link targets, dropping #anchors and files.
function links(value: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const t = m[1].trim();
    if (t && !t.includes(":")) out.push(t);
  }
  return out;
}

interface Assertion {
  focus: string; // graph QID of the article's subject
  relTitle: string; // linked relative's ja title
  dir: "parent" | "child"; // relative is X's parent, or X's child
}

// --- run --------------------------------------------------------------------
console.log(`sample=${SAMPLE} seed=${SEED}, graph nodes=${nodes.length}`);
const titleByQid = await jaTitles(focusQids);
console.log(
  `  of ${focusQids.length} sampled, ${titleByQid.size} have a ja article`,
);

const focusTitles = [...titleByQid.values()];
const wt = await wikitext(focusTitles);
console.log(`  fetched wikitext for ${wt.size} articles`);

const assertions: Assertion[] = [];
for (const [qid, title] of titleByQid) {
  const text = wt.get(title);
  if (!text) continue;
  for (const { field, value } of infoboxFields(text)) {
    let dir: "parent" | "child" | null = null;
    if (PARENT_FIELD.test(field)) dir = "parent";
    else if (CHILD_FIELD.test(field)) dir = "child";
    if (!dir) continue;
    for (const relTitle of links(value)) {
      assertions.push({ focus: qid, relTitle, dir });
    }
  }
}
console.log(`  ${assertions.length} infobox parent/child assertions`);

const relQid = await titleToQid(assertions.map((a) => a.relTitle));

const buckets = {
  connected: [] as string[],
  "missing-edge": [] as string[],
  "not-in-graph": [] as string[],
  "no-item": [] as string[],
};
const seen = new Set<string>();
for (const a of assertions) {
  const r = relQid.get(a.relTitle);
  const key = `${a.focus}|${a.relTitle}|${a.dir}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const desc = `${labelOf.get(a.focus)}(${a.focus}) ${a.dir === "parent" ? "←親" : "→子"} ${a.relTitle}${r ? `(${r})` : ""}`;
  if (!r) {
    buckets["no-item"].push(desc);
    continue;
  }
  if (r === a.focus) continue; // self-reference from a messy infobox
  const edgeKey = a.dir === "parent" ? `${r}->${a.focus}` : `${a.focus}->${r}`;
  if (edgeKeys.has(edgeKey)) buckets.connected.push(desc);
  else if (graphQids.has(r)) buckets["missing-edge"].push(desc);
  else buckets["not-in-graph"].push(desc);
}

const total =
  buckets.connected.length +
  buckets["missing-edge"].length +
  buckets["not-in-graph"].length +
  buckets["no-item"].length;
console.log(
  `\n=== ${total} distinct blood relations asserted by infoboxes ===`,
);
const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
for (const k of [
  "connected",
  "missing-edge",
  "not-in-graph",
  "no-item",
] as const) {
  console.log(
    `  ${k.padEnd(13)} ${String(buckets[k].length).padStart(5)}  ${pct(buckets[k].length)}%`,
  );
}

console.log("\n--- missing-edge examples (both items in graph, no edge) ---");
for (const s of buckets["missing-edge"].slice(0, 25)) console.log("  " + s);
console.log(
  "\n--- not-in-graph examples (relative item exists, not loaded) ---",
);
for (const s of buckets["not-in-graph"].slice(0, 15)) console.log("  " + s);
console.log("\n--- no-item examples (redlink / no Wikidata item) ---");
for (const s of buckets["no-item"].slice(0, 15)) console.log("  " + s);
