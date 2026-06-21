// Deterministic, offline reproduction of GraphPane's ego layout for debugging.
// dagre (cytoscape-dagre) is deterministic, so running the same nodes/edges and
// options headless reproduces the browser's coordinates exactly — no need to poke
// the live page. Dumps node positions, the taxi path of every drawn descent line
// (with column span and bend count), couple junctions, and spouse detours, so a
// misplaced node or an unnecessary bend shows up as numbers.
//
// Mirrors GraphPane's layout step, including dropping sibling adoptions, so the
// output reflects what the app actually draws.
//
// Usage: bun run scripts/dump-layout.ts [QID]   (default: Q319664 徳川吉宗)
//   Requires the dev server running (reads /api/person/:id/neighbors).

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type * as cytoscapeDagre from "cytoscape-dagre";
import {
  layoutOnlyEdges,
  patrilinealEdges,
  siblingAdoptiveEdges,
  type Graph,
} from "../lib/graph";
import {
  descentJunctions,
  placeNodes,
  spouseRouting,
  type Pos,
  type Positions,
} from "../lib/layout";

cytoscape.use(dagre);

// Mirror GraphPane's constants and the node-dimension styles dagre reads.
const NODE_SIZE = 16;
const NODE_SEP = 30;
const ROW = NODE_SEP + NODE_SIZE;
const SPOUSE_GUTTER = 70;
const RANK_SEP = 220;

const qid = process.argv[2] ?? "Q319664";

let graph: Graph;
try {
  const res = await fetch(
    `http://localhost:3000/api/person/${qid}/neighbors?hops=2`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  graph = await res.json();
} catch (err) {
  console.error(
    `Failed to fetch ${qid}: ${err instanceof Error ? err.message : String(err)}. Is the dev server running on http://localhost:3000? (bun run dev)`,
  );
  process.exit(1);
}

const drawnAll = patrilinealEdges(graph);
const dropped = new Set(siblingAdoptiveEdges(drawnAll)); // 家督 succession between siblings
const edges = drawnAll.filter((e) => !dropped.has(e));
const layoutEdges = layoutOnlyEdges(graph, edges);

const elements: ElementDefinition[] = [
  ...graph.nodes.map((n) => ({
    data: { id: n.qid, label: n.label, focus: n.qid === qid ? 1 : 0 },
  })),
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
  style: [
    { selector: "node", style: { width: NODE_SIZE, height: NODE_SIZE } },
    { selector: "node[focus = 1]", style: { width: 30, height: 30 } },
  ],
});

const dagreLR = (
  extra: Partial<cytoscapeDagre.DagreLayoutOptions> = {},
): cytoscapeDagre.DagreLayoutOptions => ({
  name: "dagre",
  rankDir: "LR",
  animate: false,
  ...extra,
});

cy.nodes()
  .union(
    cy.edges(
      '[type = "PARENT_OF"], [type = "LAYOUT"], [type = "ADOPTIVE_PARENT_OF"]',
    ),
  )
  .layout(dagreLR({ nodeSep: NODE_SEP, rankSep: RANK_SEP, fit: false }))
  .run();

const positions: Positions = new Map();
cy.nodes().forEach((n) => {
  positions.set(n.id(), { x: n.position("x"), y: n.position("y") });
});
const placed = placeNodes(positions, edges, qid, ROW);

const label = (id: string) =>
  graph.nodes.find((n) => n.qid === id)?.label ?? id;
const r = (n: number) => Math.round(n);

// cytoscape taxi (rightward, turn 50%): a line from (sx,sy) to (tx,ty) goes right
// to the half-x, turns vertically, then right again. Two bend points when sy≠ty.
const taxiPoints = (s: Pos, t: Pos): Pos[] => {
  const mx = s.x + (t.x - s.x) / 2;
  return s.y === t.y ? [s, t] : [s, { x: mx, y: s.y }, { x: mx, y: t.y }, t];
};
const fmt = (pts: Pos[]) => pts.map((p) => `(${r(p.x)},${r(p.y)})`).join(" → ");
const COL = NODE_SIZE + RANK_SEP; // one generation's x-stride

console.log(`# ${label(qid)} (${qid})\n`);

console.log("## Nodes (x, y)");
for (const [id, p] of placed) {
  console.log(`  ${r(p.x)}, ${r(p.y)}  ${label(id)} (${id})`);
}

if (dropped.size) {
  console.log(
    "\n## Dropped non-descent adoptions (kin succession; not drawn/ranked)",
  );
  for (const e of dropped)
    console.log(`  ${label(e.source)} →(養) ${label(e.target)}`);
}

console.log("\n## Drawn descent lines (taxi path)  [cols=column span, bends]");
for (const e of edges) {
  if (e.type !== "PARENT_OF" && e.type !== "ADOPTIVE_PARENT_OF") continue;
  const s = placed.get(e.source);
  const t = placed.get(e.target);
  if (!s || !t) continue;
  const cols = Math.round((t.x - s.x) / COL);
  const bends = s.y === t.y ? 0 : 2;
  console.log(
    `  ${label(e.source)} →${e.type === "ADOPTIVE_PARENT_OF" ? "(養)" : ""} ${label(e.target)}: ${fmt(taxiPoints(s, t))}  [cols=${cols}, bends=${bends}]`,
  );
}

console.log("\n## Spouse detours (bowed lines)");
const detours = spouseRouting(placed, edges, SPOUSE_GUTTER);
if (detours.length === 0) console.log("  (none)");
for (const d of detours) console.log(`  ${d.edgeId}  bow=${d.bow}`);

console.log("\n## Descent junctions (couple midpoint → children)");
for (const j of descentJunctions(graph, edges, placed, ROW)) {
  console.log(`  junction ${j.id}  pos: ${r(j.pos.x)}, ${r(j.pos.y)}`);
  for (const c of j.children) {
    const cp = placed.get(c)!;
    const dy = r(cp.y - j.pos.y);
    console.log(
      `    -> ${label(c)} (${c}) at ${r(cp.x)}, ${r(cp.y)}  dy=${dy}`,
    );
  }
}
