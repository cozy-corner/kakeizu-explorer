// Report every SPOUSE_OF edge whose two partners land in different generation
// columns (a marriage line drawn across generations). Reproduces GraphPane's ego
// layout offline exactly like dump-layout.ts, then diffs each spouse pair's column.
//
// Usage: bun run scripts/find-cross-gen-marriages.ts [QID] [--hops N]
//   Requires the dev server (reads /api/person/:id/neighbors).

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  layoutOnlyEdges,
  withoutAdoptions,
  type Graph,
  type PersonId,
} from "../lib/graph";
import {
  placeNodes,
  project,
  readPlacement,
  type Positions,
} from "../lib/layout";
import { NODE_SIZE, RANK_SEP, ROW, runEgoLayout, STYLE } from "../lib/render";

cytoscape.use(dagre);

const args = process.argv.slice(2);
const qid = (args.find((a) => !a.startsWith("--")) ?? "Q187550") as PersonId;
const hopsArg = args.indexOf("--hops");
const hops = hopsArg >= 0 ? Number(args[hopsArg + 1]) : 2;
const showAdoptions = !args.includes("--blood");

const res = await fetch(
  `http://localhost:3000/api/person/${qid}/neighbors?hops=${hops}`,
);
const raw: Graph = await res.json();
const graph = showAdoptions ? raw : withoutAdoptions(raw, qid);

const edges = egoDrawnEdges(graph);
const layoutEdges = layoutOnlyEdges(graph, edges);
const elements: ElementDefinition[] = [
  ...graph.nodes.map((n) => ({ data: { id: n.qid, label: n.label } })),
  ...[...edges, ...layoutEdges].map((e) => ({
    data: {
      id: `${e.source}|${e.type}|${e.target}`,
      source: e.source,
      target: e.target,
      type: e.type,
    },
  })),
];
const cy: Core = cytoscape({
  headless: true,
  styleEnabled: true,
  elements,
  style: STYLE,
});
runEgoLayout(cy);

const pos: Positions = new Map();
cy.nodes().forEach((n) => {
  pos.set(n.id() as PersonId, { x: n.position("x"), y: n.position("y") });
});
const fam = buildFamilyGraph(graph, edges);
const { placements, colX } = readPlacement(pos, ROW);
const placed = project(placeNodes(placements, fam, qid), colX, ROW);

const label = (id: string) =>
  graph.nodes.find((n) => n.qid === id)?.label ?? id;
const col = (id: string) => placed.get(id as PersonId)?.x;
const COL = NODE_SIZE + RANK_SEP;

console.log(
  `# ${label(qid)} (${qid})  hops=${hops} adoptions=${showAdoptions}`,
);
console.log(`nodes=${graph.nodes.length}\n`);

const seen = new Set<string>();
const found: string[] = [];
for (const e of graph.edges) {
  if (e.type !== "SPOUSE_OF") continue;
  const ca = col(e.source);
  const cb = col(e.target);
  if (ca === undefined || cb === undefined || ca === cb) continue;
  const k = [e.source, e.target].sort().join("|");
  if (seen.has(k)) continue;
  seen.add(k);
  const gens = Math.round(Math.abs(ca - cb) / COL);
  found.push(
    `  ${label(e.source)}(x=${ca}) ⟷ ${label(e.target)}(x=${cb})  Δ=${gens}gen`,
  );
}
console.log(`Cross-generation marriages: ${found.length}`);
for (const f of found) console.log(f);
