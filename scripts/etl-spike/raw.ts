// Raw extraction schema (issue #44): the E stage persists every attribute it
// touches here, ONCE, so the T stages filter locally with zero WDQS re-visits.
// Node discovery (fetch.ts, traverse.ts) fills these; the transforms
// (filter-foreign.ts, split-adoptions.ts, load.ts) only read them.
//
// Design constraint (behavior-preserving refactor): the extraction logic that
// decides WHICH edges/nodes exist is unchanged — spine/spouse/sibling still come
// from truthy `wdt:`. Reified `p:/ps:/pq:` is used only to ATTACH per-statement
// attributes (rank, P1039, P1480) to the already-truthy parent→child edges, and
// to fold the two former reified passes into one.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DATA_DIR = join(import.meta.dirname, "data");

export type Sex = "male" | "female" | "other";
export type Rank = "preferred" | "normal" | "deprecated";

// A person. `nationalities` are P27 target QIDs; `nationalityCountries` are the
// P27→P17 countries of those citizenships (Edo shogunate → Japan, etc.). Both
// are kept because the two nationality rules disagree: traverse's frontier uses
// the narrow rule (P27 ∋ Q17), foreign-pruning uses the broad rule
// (P27 ∋ Q17 ∨ P27→P17 ∋ Q17).
export interface RawNode {
  qid: string;
  label: string;
  sex?: Sex; // P21; omitted when Wikidata records none
  nationalities: string[];
  nationalityCountries: string[];
}

// A truthy parent→child edge, annotated from its reified statement(s). `role`
// (P1039) marks adoptive kinship; `*SideRank` carry the ranks of the child-side
// (P22/P25) and parent-side (P40) statements so #43 (deprecated父辺 removal) can
// stay a pure-local transform later. `sourcing` are P1480 QIDs (presumed, etc.),
// captured for the future presumed-suppression transform. #44 itself only uses
// `role` + non-deprecated for the adoptive split.
export interface RawParentEdge {
  from: string; // parent
  to: string; // child
  childSideRank?: Rank;
  parentSideRank?: Rank;
  role?: string; // P1039 kinship QID
  sourcing: string[]; // P1480 QIDs
}

export interface RawPair {
  a: string;
  b: string;
}

// A directed adoptive relation, already oriented adoptiveParent→child. Kept as
// its own raw stream because adoption is recorded in ways the truthy parent
// spine can't reach: via P1038 (generic "relative") and via non-best-rank
// P22/P25/P40 statements. The local split filters these to in-graph nodes.
export interface RawEdge {
  from: string;
  to: string;
}

export async function readRaw<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")) as T;
}

export async function writeRaw(name: string, data: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, name), JSON.stringify(data));
}

export const RAW_NODES = "raw-nodes.json";
export const RAW_PARENT = "raw-parent.json";
export const RAW_SPOUSE = "raw-spouse.json";
export const RAW_SIBLING = "raw-sibling.json";
export const RAW_ADOPTIONS = "raw-adoptions.json";
