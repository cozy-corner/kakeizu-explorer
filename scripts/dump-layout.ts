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
// Usage: bun run scripts/dump-layout.ts [QID] [--json]   (default: Q319664 徳川吉宗)
//   Requires the dev server running (reads /api/person/:id/neighbors).
//   --json emits the same data machine-readably so derived quantities (gaps, row
//   skew) are a `jq` one-liner instead of a brittle awk parse of the prose.

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  junctionId,
  layoutOnlyEdges,
  patrilinealEdges,
  type Graph,
  type GraphEdge,
  type PersonId,
} from "../lib/graph";
import {
  centerOnlyChildren,
  descentJunctions,
  placeNodes,
  project,
  projectOne,
  readPlacement,
  spouseRouting,
  type Pos,
  type Positions,
} from "../lib/layout";
import {
  NODE_SIZE,
  RANK_SEP,
  ROW,
  runEgoLayout,
  SPOUSE_GUTTER,
  STYLE,
} from "../lib/render";

cytoscape.use(dagre);

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const qid = (args.find((a) => !a.startsWith("--")) ?? "Q319664") as PersonId;

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

const edges = egoDrawnEdges(graph);
const layoutEdges = layoutOnlyEdges(graph, edges);
// Report-only: the sibling adoptions egoDrawnEdges removed (kin succession, not
// drawn/ranked). Derived as the difference so it tracks the drop rule, not a copy.
const edgeKey = (e: GraphEdge) => `${e.source}|${e.type}|${e.target}`;
const kept = new Set(edges.map(edgeKey));
const dropped = patrilinealEdges(graph).filter((e) => !kept.has(edgeKey(e)));

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
  style: STYLE,
});

runEgoLayout(cy);

const positions: Positions = new Map();
cy.nodes().forEach((n) => {
  positions.set(n.id() as PersonId, { x: n.position("x"), y: n.position("y") });
});
const fam = buildFamilyGraph(graph, edges);
const { placements, colX } = readPlacement(positions, ROW);
const placedStruct = centerOnlyChildren(
  placeNodes(placements, fam, qid),
  fam,
  qid,
);
const placed = project(placedStruct, colX, ROW);

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

// Build the structured data once; prose and --json render from the same arrays so
// the two views can't drift. The prose rendering below must stay byte-identical to
// the previous output (acceptance condition: default format unchanged).
type NodeOut = { id: string; label: string; x: number; y: number };
type DroppedAdoption = {
  source: string;
  sourceLabel: string;
  target: string;
  targetLabel: string;
};
type DescentLine = {
  source: string;
  sourceLabel: string;
  target: string;
  targetLabel: string;
  adoptive: boolean;
  path: Pos[];
  cols: number;
  bends: number;
};
type Junction = {
  id: string;
  father: string;
  mother: string;
  x: number;
  y: number;
  children: { id: string; label: string; x: number; y: number; dy: number }[];
};

const nodesOut: NodeOut[] = [...placed].map(([id, p]) => ({
  id,
  label: label(id),
  x: r(p.x),
  y: r(p.y),
}));

const droppedOut: DroppedAdoption[] = dropped.map((e) => ({
  source: e.source,
  sourceLabel: label(e.source),
  target: e.target,
  targetLabel: label(e.target),
}));

const descentOut: DescentLine[] = [];
for (const e of edges) {
  if (e.type !== "PARENT_OF" && e.type !== "ADOPTIVE_PARENT_OF") continue;
  const s = placed.get(e.source as PersonId);
  const t = placed.get(e.target as PersonId);
  if (!s || !t) continue;
  descentOut.push({
    source: e.source,
    sourceLabel: label(e.source),
    target: e.target,
    targetLabel: label(e.target),
    adoptive: e.type === "ADOPTIVE_PARENT_OF",
    path: taxiPoints(s, t).map((p) => ({ x: r(p.x), y: r(p.y) })),
    cols: Math.round((t.x - s.x) / COL),
    bends: s.y === t.y ? 0 : 2,
  });
}

const detoursOut = spouseRouting(placed, fam, SPOUSE_GUTTER);

const junctionsOut: Junction[] = [];
for (const j of descentJunctions(fam, placedStruct)) {
  const jpos = projectOne(j.pos, colX, ROW);
  const children: Junction["children"] = [];
  for (const c of j.children) {
    const cp = placed.get(c);
    if (!cp) {
      console.error(`    -> ${label(c)} (${c}) MISSING from placed map`);
      continue;
    }
    children.push({
      id: c,
      label: label(c),
      x: r(cp.x),
      y: r(cp.y),
      dy: r(cp.y - jpos.y),
    });
  }
  junctionsOut.push({
    id: junctionId(j.father, j.mother),
    father: j.father,
    mother: j.mother,
    x: r(jpos.x),
    y: r(jpos.y),
    children,
  });
}

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        focus: { id: qid, label: label(qid) },
        nodes: nodesOut,
        droppedAdoptions: droppedOut,
        descentLines: descentOut,
        spouseDetours: detoursOut,
        junctions: junctionsOut,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`# ${label(qid)} (${qid})\n`);

  console.log("## Nodes (x, y)");
  for (const n of nodesOut)
    console.log(`  ${n.x}, ${n.y}  ${n.label} (${n.id})`);

  if (droppedOut.length) {
    console.log(
      "\n## Dropped non-descent adoptions (kin succession; not drawn/ranked)",
    );
    for (const e of droppedOut)
      console.log(`  ${e.sourceLabel} →(養) ${e.targetLabel}`);
  }

  console.log(
    "\n## Drawn descent lines (taxi path)  [cols=column span, bends]",
  );
  for (const e of descentOut) {
    console.log(
      `  ${e.sourceLabel} →${e.adoptive ? "(養)" : ""} ${e.targetLabel}: ${fmt(e.path)}  [cols=${e.cols}, bends=${e.bends}]`,
    );
  }

  console.log("\n## Spouse detours (bowed lines)");
  if (detoursOut.length === 0) console.log("  (none)");
  for (const d of detoursOut)
    console.log(`  ${d.source}|SPOUSE_OF|${d.target}  bow=${d.bow}`);

  console.log("\n## Descent junctions (couple midpoint → children)");
  for (const j of junctionsOut) {
    console.log(`  junction ${j.id}  pos: ${j.x}, ${j.y}`);
    for (const c of j.children) {
      console.log(`    -> ${c.label} (${c.id}) at ${c.x}, ${c.y}  dy=${c.dy}`);
    }
  }
}
