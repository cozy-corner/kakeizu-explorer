// Raw extraction schema: the E stage persists every attribute ONCE here, so the T
// stages filter locally with zero WDQS re-visits. fetch.ts / traverse.ts fill
// these; transform.ts and load.ts only read them. Which edges/nodes exist comes
// from truthy `wdt:`; reified `p:/ps:/pq:` only attaches per-statement attributes
// to the truthy parent→child edges.

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
  // ja.wikipedia article title from the Wikidata sitelink (schema:name), so the
  // article pane opens the canonical page instead of guessing from `label`.
  // Omitted when the person has no ja.wikipedia article.
  wikipediaTitle?: string;
  nationalities: string[];
  nationalityCountries: string[];
}

// A truthy parent→child edge, annotated from its reified statement(s). `role`
// (P1039) marks adoptive kinship; `*SideRank` carry the child-side (P22/P25) and
// parent-side (P40) statement ranks, so deprecated-父辺 removal can stay a local
// transform. `sourcing` are P1480 QIDs (presumed, etc.), for a later
// presumed-suppression transform.
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
export interface RawAdoptiveEdge {
  from: string;
  to: string;
}

// A node's captured attributes, or an empty-attribute default keyed by qid (for a
// node Wikidata returned nothing for).
export const rawNodeOr = (q: string, attrs: Map<string, RawNode>): RawNode =>
  attrs.get(q) ?? {
    qid: q,
    label: q,
    nationalities: [],
    nationalityCountries: [],
  };

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
