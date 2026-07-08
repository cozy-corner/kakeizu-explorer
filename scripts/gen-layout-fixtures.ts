// Regenerate the golden fixtures lib/layout.test.ts asserts against — the one
// live-dependent step, so lib/layout itself can be tested offline. Runs the view's
// own dagre setup (lib/render's STYLE + runEgoLayout, so the frozen coordinates can't
// drift from what the app draws) and writes {graph, dagre input, expected} per case.
//
// Run with the dev server up (Neo4j-backed): bun run scripts/gen-layout-fixtures.ts
// Eyeball the emitted `expected` before committing — it is a snapshot, not an oracle.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  layoutOnlyEdges,
  type Graph,
  type GraphEdge,
  type PersonId,
} from "../lib/graph";
import {
  placeNodes,
  project,
  readPlacement,
  spouseRouting,
  type Positions,
} from "../lib/layout";
import { ROW, runEgoLayout, SPOUSE_GUTTER, STYLE } from "../lib/render";

cytoscape.use(dagre);

function dagrePositions(graph: Graph, focus: PersonId): Positions {
  const edges = egoDrawnEdges(graph);
  const layoutEdges = layoutOnlyEdges(graph, edges);
  const elements: ElementDefinition[] = [
    ...graph.nodes.map((n) => ({
      data: { id: n.qid, label: n.label, focus: n.qid === focus ? 1 : 0 },
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
  const pos: Positions = new Map();
  cy.nodes().forEach((n) => {
    pos.set(n.id() as PersonId, { x: n.position("x"), y: n.position("y") });
  });
  return pos;
}

// The pure pipeline the test replays: readPlacement → placeNodes → project, then
// spouse routing. Matches lib/layout.test.ts's `place` (centerOnlyChildren is a
// render-only pass, deliberately outside this placement contract).
function computeExpected(graph: Graph, focus: PersonId, dagre: Positions) {
  const fam = buildFamilyGraph(graph, egoDrawnEdges(graph));
  const { placements, colX } = readPlacement(dagre, ROW);
  const positions = project(placeNodes(placements, fam, focus), colX, ROW);
  const routing = spouseRouting(positions, fam, SPOUSE_GUTTER);
  return { positions, routing };
}

const posToJson = (p: Positions): Record<string, [number, number]> =>
  Object.fromEntries([...p].map(([id, { x, y }]) => [id, [x, y]]));

async function ego(qid: string): Promise<Graph> {
  const res = await fetch(
    `http://localhost:3000/api/person/${encodeURIComponent(qid)}/neighbors?hops=2`,
  );
  if (!res.ok) {
    throw new Error(`ego(${qid}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Graph;
}

// ---------- synthetic cases: order-dependent branches, node order vs edge order ----------
const P = (source: string, target: string): GraphEdge => ({
  source,
  target,
  type: "PARENT_OF",
});
const SP = (source: string, target: string): GraphEdge => ({
  source,
  target,
  type: "SPOUSE_OF",
});
const AP = (source: string, target: string): GraphEdge => ({
  source,
  target,
  type: "ADOPTIVE_PARENT_OF",
});
const ns = (...qids: string[]) => qids.map((qid) => ({ qid, label: qid }));

type Spec = { file: string; qid: PersonId; label: string; graph: Graph };

// Fetched from the live API, then frozen. File name is the QID. Marriage-heavy
// cross-family figures (お市/浅井長政/北条政子) are kept in so the spouse-routing
// bow branch is exercised, not just the "no detour" branch.
const realCases: { qid: PersonId; label: string }[] = [
  { qid: "Q171411" as PersonId, label: "織田信長" },
  { qid: "Q171977" as PersonId, label: "徳川家康" },
  { qid: "Q348466" as PersonId, label: "徳川家茂(養子)" },
  { qid: "Q314464" as PersonId, label: "徳川秀忠" },
  { qid: "Q314481" as PersonId, label: "徳川家光" },
  { qid: "Q635214" as PersonId, label: "お市の方" },
  { qid: "Q187550" as PersonId, label: "豊臣秀吉" },
  { qid: "Q1142446" as PersonId, label: "浅井長政" },
  { qid: "Q463961" as PersonId, label: "北条政子" },
];

// Static — the node list is ordered to DISAGREE with the edge order, pinning which
// ordering each order-dependent branch uses.
const syntheticSpecs: Spec[] = [
  {
    file: "syn-married-in-2-anchors",
    qid: "cA1" as PersonId,
    label: "syn: married-in, 2 anchors",
    graph: {
      nodes: ns("B", "A", "W", "cA1", "cA2", "cB1"),
      edges: [
        SP("W", "A"),
        SP("W", "B"),
        P("A", "cA1"),
        P("A", "cA2"),
        P("B", "cB1"),
      ],
    },
  },
  {
    file: "syn-2-adoptive-parents",
    qid: "F" as PersonId,
    label: "syn: 2 adoptive parents",
    graph: {
      nodes: ns("AP2", "AP1", "PA", "F", "sib"),
      edges: [AP("AP1", "F"), AP("AP2", "F"), P("PA", "F"), P("PA", "sib")],
    },
  },
  {
    file: "syn-focus-2-blood-spouses",
    qid: "FO" as PersonId,
    label: "syn: focus 2 blood spouses",
    graph: {
      nodes: ns("S2", "S1", "PA", "PB1", "PB2", "FO", "sib"),
      edges: [
        SP("FO", "S1"),
        SP("FO", "S2"),
        P("PA", "FO"),
        P("PA", "sib"),
        P("PB1", "S1"),
        P("PB2", "S2"),
      ],
    },
  },
];

const OUT_DIR = join(import.meta.dir, "..", "lib", "fixtures", "layout");
mkdirSync(OUT_DIR, { recursive: true });

function writeFixture({ file, qid, label, graph }: Spec): void {
  const dagre = dagrePositions(graph, qid);
  const { positions, routing } = computeExpected(graph, qid, dagre);
  const fixture = {
    qid,
    label,
    graph,
    dagre: posToJson(dagre),
    expected: { positions: posToJson(positions), routing },
  };
  writeFileSync(
    join(OUT_DIR, `${file}.json`),
    JSON.stringify(fixture, null, 2),
  );
  console.log(
    `wrote ${file}.json — ${graph.nodes.length} nodes, ${routing.length} routed`,
  );
}

for (const { qid, label } of realCases) {
  const graph = await ego(qid);
  if (!graph.nodes.length) {
    console.log(`SKIP ${label} (${qid}): empty graph`);
    continue;
  }
  writeFixture({ file: qid, qid, label, graph });
}
for (const spec of syntheticSpecs) writeFixture(spec);
