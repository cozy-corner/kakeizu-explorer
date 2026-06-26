// Behavior-preservation check for issue #18: run the OLD cytoscape-coupled
// placement (copied verbatim from main's GraphPane) and the NEW pure lib/layout
// on the SAME dagre output for real ego graphs, then diff. Identical positions +
// spouse routing across every graph = the extraction preserved behavior.
//
// Run with the dev server up (Neo4j-backed): bun run scripts/layout-parity.ts
import cytoscape, { type Core, type NodeSingular } from "cytoscape";
import dagre from "cytoscape-dagre";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  layoutOnlyEdges,
  type Graph,
  type GraphEdge,
} from "../lib/graph";
import { placeNodes, spouseRouting, type Positions } from "../lib/layout";

cytoscape.use(dagre);

const NODE_SIZE = 16;
const NODE_SEP = 30;
const ROW = NODE_SEP + NODE_SIZE;
const SPOUSE_GUTTER = 70;

// ---------- OLD logic, verbatim from main (routeSpouseEdges returns decisions) ----------
const isMarriedIn = (n: NodeSingular): boolean =>
  n
    .connectedEdges('[type = "PARENT_OF"], [type = "ADOPTIVE_PARENT_OF"]')
    .empty();

function packColumns(cy: Core, focusQid: string): void {
  const hostOf = (n: NodeSingular): NodeSingular | null => {
    const anchors = n
      .connectedEdges('[type = "SPOUSE_OF"]')
      .connectedNodes()
      .filter((p) => p.id() !== n.id() && !isMarriedIn(p));
    if (anchors.empty()) return null;
    const focused = anchors.filter((p) => p.id() === focusQid);
    return (
      focused.nonempty() ? focused.first() : anchors.first()
    ) as NodeSingular;
  };

  const attached = new Map<string, NodeSingular[]>();
  cy.nodes().forEach((n) => {
    if (!isMarriedIn(n)) return;
    const host = hostOf(n);
    if (!host) return;
    const list =
      attached.get(host.id()) ?? attached.set(host.id(), []).get(host.id())!;
    list.push(n);
    n.position(host.position());
  });

  const focus = cy.getElementById(focusQid);
  if (focus.nonempty() && !isMarriedIn(focus as NodeSingular)) {
    const focusX = Math.round(focus.position("x"));
    focus
      .connectedEdges('[type = "SPOUSE_OF"]')
      .connectedNodes()
      .forEach((sp: NodeSingular) => {
        if (sp.id() === focusQid || isMarriedIn(sp)) return;
        if (Math.round(sp.position("x")) !== focusX) return;
        const list =
          attached.get(focusQid) ?? attached.set(focusQid, []).get(focusQid)!;
        list.push(sp);
      });
  }

  const attachedIds = new Set([...attached.values()].flat().map((s) => s.id()));

  const cols = new Map<number, NodeSingular[]>();
  cy.nodes().forEach((n) => {
    const x = Math.round(n.position("x"));
    (cols.get(x) ?? cols.set(x, []).get(x)!).push(n);
  });

  cols.forEach((colNodes) => {
    const seeds = colNodes
      .filter((n) => !attachedIds.has(n.id()))
      .sort((a, b) => a.position("y") - b.position("y"));
    const order: NodeSingular[] = [];
    const expand = (n: NodeSingular): void => {
      order.push(n);
      for (const a of attached.get(n.id()) ?? []) expand(a);
    };
    for (const s of seeds) expand(s);
    const x = order[0].position("x");
    let prevY = -Infinity;
    for (const n of order) {
      const y = attachedIds.has(n.id())
        ? prevY + ROW
        : Math.max(prevY + ROW, n.position("y"));
      n.position({ x, y });
      prevY = y;
    }
  });
}

function placeAdoptiveParents(cy: Core, focusQid: string): void {
  const focus = cy.getElementById(focusQid);
  if (focus.empty()) return;
  const bloodParents = focus.incomers('edge[type = "PARENT_OF"]').sources();
  const parents = focus
    .connectedEdges('[type = "ADOPTIVE_PARENT_OF"]')
    .filter((e) => e.target().id() === focusQid)
    .sources()
    .filter((p: NodeSingular) => !bloodParents.anySame(p));
  if (parents.empty()) return;
  const focusX = Math.round(focus.position("x"));
  const clusterBottom = Math.max(
    ...cy
      .nodes()
      .filter((n: NodeSingular) => Math.round(n.position("x")) === focusX)
      .map((n: NodeSingular) => n.position("y")),
  );
  let y = clusterBottom + ROW;
  parents.forEach((p: NodeSingular) => {
    p.position("y", y);
    y += ROW;
  });
}

function routeSpouseEdgesDecision(cy: Core): { edgeId: string; bow: number }[] {
  const out: { edgeId: string; bow: number }[] = [];
  const nodes = cy.nodes().toArray();
  cy.edges('[type = "SPOUSE_OF"]').forEach((e) => {
    const s = e.source();
    const t = e.target();
    const sp = s.position();
    const tp = t.position();
    const [yLo, yHi] = sp.y < tp.y ? [sp.y, tp.y] : [tp.y, sp.y];
    const x = (sp.x + tp.x) / 2;
    const coSpouses = s
      .connectedEdges('[type = "SPOUSE_OF"]')
      .connectedNodes()
      .union(t.connectedEdges('[type = "SPOUSE_OF"]').connectedNodes());
    const blocked = nodes.some((n) => {
      if (n.same(s) || n.same(t) || coSpouses.anySame(n)) return false;
      const p = n.position();
      return p.y > yLo + 8 && p.y < yHi - 8 && Math.abs(p.x - x) < 24;
    });
    if (!blocked) return;
    const d = (tp.y > sp.y ? 1 : -1) * SPOUSE_GUTTER;
    out.push({ edgeId: e.id(), bow: d });
  });
  return out;
}

// ---------- harness ----------
async function ego(qid: string): Promise<Graph> {
  const res = await fetch(
    `http://localhost:3000/api/person/${encodeURIComponent(qid)}/neighbors?hops=2`,
  );
  if (!res.ok) {
    throw new Error(`ego(${qid}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Graph;
}

function buildCy(
  graph: Graph,
  focus: string,
): { cy: Core; edges: GraphEdge[] } {
  const edges = egoDrawnEdges(graph);
  const layoutEdges = layoutOnlyEdges(graph, edges);
  const elements = [
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
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [
      { selector: "node", style: { width: NODE_SIZE, height: NODE_SIZE } },
      { selector: "node[focus = 1]", style: { width: 30, height: 30 } },
    ],
  });
  cy.nodes()
    .union(
      cy.edges(
        '[type = "PARENT_OF"], [type = "LAYOUT"], [type = "ADOPTIVE_PARENT_OF"]',
      ),
    )
    .layout({
      name: "dagre",
      rankDir: "LR",
      animate: false,
      nodeSep: NODE_SEP,
      rankSep: 220,
      fit: false,
    } as cytoscape.LayoutOptions)
    .run();
  return { cy, edges };
}

function snapshot(cy: Core): Positions {
  const m: Positions = new Map();
  cy.nodes().forEach((n) => {
    m.set(n.id(), { x: n.position("x"), y: n.position("y") });
  });
  return m;
}

function restore(cy: Core, p: Positions): void {
  for (const [id, pos] of p) cy.getElementById(id).position({ ...pos });
}

const EPS = 1e-6;

function runParity(graph: Graph, qid: string, label: string): number {
  const { cy, edges } = buildCy(graph, qid);
  const P0 = snapshot(cy);
  const distinctX = new Set([...P0.values()].map((p) => Math.round(p.x))).size;

  // NEW (pure)
  const fam = buildFamilyGraph(graph, edges);
  const placed = placeNodes(
    new Map([...P0].map(([id, p]) => [id, { ...p }])),
    fam,
    qid,
    ROW,
  );
  const newRouting = spouseRouting(placed, fam, SPOUSE_GUTTER);

  // OLD (cytoscape), from the same dagre snapshot
  restore(cy, P0);
  packColumns(cy, qid);
  placeAdoptiveParents(cy, qid);
  const Pold = snapshot(cy);
  const oldRouting = routeSpouseEdgesDecision(cy);

  // Diff the union of ids so a node dropped by EITHER side is flagged.
  const posDiffs: string[] = [];
  for (const id of new Set([...placed.keys(), ...Pold.keys()])) {
    const np = placed.get(id);
    const op = Pold.get(id);
    if (!np || !op) {
      posDiffs.push(`  ${id}: ${np ? "missing in OLD" : "missing in NEW"}`);
    } else if (Math.abs(np.x - op.x) > EPS || Math.abs(np.y - op.y) > EPS) {
      posDiffs.push(
        `  ${id}: new(${np.x.toFixed(1)},${np.y.toFixed(1)}) old(${op.x.toFixed(1)},${op.y.toFixed(1)})`,
      );
    }
  }

  const key = (r: { edgeId: string; bow: number }) => `${r.edgeId}=${r.bow}`;
  const newSet = new Set(newRouting.map(key));
  const oldSet = new Set(oldRouting.map(key));
  const routeDiffs = [
    ...[...newSet].filter((k) => !oldSet.has(k)).map((k) => `  +new ${k}`),
    ...[...oldSet].filter((k) => !newSet.has(k)).map((k) => `  +old ${k}`),
  ];

  const bad = posDiffs.length + routeDiffs.length;
  console.log(
    `${bad === 0 ? "OK  " : "DIFF"} ${label} (${qid}): ${graph.nodes.length} nodes, ${distinctX} cols, ${newRouting.length} routed${bad ? ` — ${bad} mismatch` : ""}`,
  );
  for (const d of [...posDiffs, ...routeDiffs]) console.log(d);
  return bad;
}

let totalMismatch = 0;

// Real ego graphs from the live API.
const focuses: [string, string][] = [
  ["Q171411", "織田信長"],
  ["Q635214", "お市の方"],
  ["Q348466", "徳川家茂(養子)"],
  ["Q171977", "徳川家康"],
  ["Q187550", "豊臣秀吉"],
  ["Q314464", "徳川秀忠"],
  ["Q1142446", "浅井長政"],
  ["Q314481", "徳川家光"],
  ["Q463961", "北条政子"],
];
for (const [qid, label] of focuses) {
  const graph = await ego(qid);
  if (!graph.nodes.length) {
    console.log(`SKIP ${label} (${qid}): empty graph`);
    continue;
  }
  totalMismatch += runParity(graph, qid, label);
}

// Synthetic graphs targeting the order-dependent branches the pure port replaced
// with edge-array order (OLD used cytoscape collection order). In each, the node
// list is ordered to DISAGREE with the edge order, so the case is sensitive to
// whichever ordering each side actually uses — a different pick diverges and fails.
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

const synthetic: { graph: Graph; qid: string; label: string }[] = [
  {
    // Married-in W has two non-focus anchors A,B (hostOf tie-break). Nodes list B
    // before A, but edges put W-A before W-B.
    label: "syn: married-in, 2 anchors",
    qid: "cA1",
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
    // Focus F has two distinct adoptive parents AP1,AP2 (stacking order). Nodes
    // list AP2 before AP1, edges put AP1 before AP2.
    label: "syn: 2 adoptive parents",
    qid: "F",
    graph: {
      nodes: ns("AP2", "AP1", "PA", "F", "sib"),
      edges: [AP("AP1", "F"), AP("AP2", "F"), P("PA", "F"), P("PA", "sib")],
    },
  },
  {
    // Focus FO has two own-blood-line spouses S1,S2 in its column (focus-spouse
    // attach order). Nodes list S2 before S1, edges put FO-S1 before FO-S2.
    label: "syn: focus 2 blood spouses",
    qid: "FO",
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
for (const { graph, qid, label } of synthetic) {
  totalMismatch += runParity(graph, qid, label);
}

console.log(
  totalMismatch === 0
    ? "\nPARITY OK: old and new are identical on every graph."
    : `\nPARITY FAILED: ${totalMismatch} mismatches.`,
);
process.exit(totalMismatch === 0 ? 0 : 1);
