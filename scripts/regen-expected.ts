// Recompute only the `expected` block of each golden fixture from its frozen
// `graph` + `dagre` input — DB-free, and it leaves `graph`/`dagre` byte-identical
// so the diff shows just the placement contract that actually changed. Use this
// (not gen-layout-fixtures, which re-fetches and perturbs the frozen input) when a
// pure lib/layout change alters placements but the dagre ranking is untouched.
//
// Usage: bun run scripts/regen-expected.ts
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  type Graph,
  type PersonId,
} from "../lib/graph";
import {
  placeNodes,
  project,
  readPlacement,
  spouseRouting,
  type Positions,
} from "../lib/layout";
import { ROW, SPOUSE_GUTTER } from "../lib/render";

const DIR = join(import.meta.dir, "..", "lib", "fixtures", "layout");
const pos = (m: Record<string, [number, number]>): Positions =>
  new Map(Object.entries(m).map(([id, [x, y]]) => [id as PersonId, { x, y }]));
const toJson = (p: Positions): Record<string, [number, number]> =>
  Object.fromEntries([...p].map(([id, { x, y }]) => [id, [x, y]]));

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const fx = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const graph: Graph = fx.graph;
  const fam = buildFamilyGraph(graph, egoDrawnEdges(graph));
  const { placements, colX } = readPlacement(pos(fx.dagre), ROW);
  const positions = project(placeNodes(placements, fam, fx.qid), colX, ROW);
  fx.expected = {
    positions: toJson(positions),
    routing: spouseRouting(positions, fam, SPOUSE_GUTTER),
  };
  writeFileSync(join(DIR, file), JSON.stringify(fx, null, 2) + "\n");
  console.log(`updated ${file}`);
}
