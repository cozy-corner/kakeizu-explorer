"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type * as cytoscapeDagre from "cytoscape-dagre";
import { useEffect, useRef, useState } from "react";
import { layoutOnlyEdges, patrilinealEdges, type Graph } from "@/lib/graph";
import {
  descentJunctions,
  placeNodes,
  spouseRouting,
  type Positions,
} from "@/lib/layout";

cytoscape.use(dagre);

export type FocusPerson = { qid: string; label: string };

const HOPS = 2;

const NODE_SIZE = 16;
const NODE_SEP = 30;
const ROW = NODE_SEP + NODE_SIZE;

// Genealogy-chart styling: PARENT_OF is drawn as a rightward right-angle (taxi)
// line with an arrow — the tree spine flows left→right; SPOUSE_OF is a straight
// link joining a couple. Sibling edges are never emitted (siblings share a parent).
const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "#64748b",
      label: "data(label)",
      "font-size": "10px",
      color: "#0f172a",
      "text-outline-width": 2,
      "text-outline-color": "#f8fafc",
      // Left-to-right tree with horizontal labels: put the name to the right of
      // each node so vertically-stacked siblings' labels don't collide.
      "text-valign": "center",
      "text-halign": "right",
      "text-margin-x": 4,
      width: NODE_SIZE,
      height: NODE_SIZE,
    },
  },
  {
    selector: "node[focus = 1]",
    style: {
      "background-color": "#dc2626",
      width: 30,
      height: 30,
      "font-size": "13px",
      "font-weight": "bold",
      "z-index": 10,
    },
  },
  {
    // Invisible anchor at a couple's midpoint; the descent line sprouts from it.
    // Drawn as a zero-size, click-through dot so its child edges still render
    // while the node itself shows nothing and isn't selectable.
    selector: "node[junction = 1]",
    style: { width: 1, height: 1, "background-opacity": 0, events: "no" },
  },
  {
    selector: "edge",
    style: { width: 1.5, "curve-style": "bezier", "line-color": "#cbd5e1" },
  },
  {
    // Both parent→child relations flow as a rightward right-angle (taxi) line with an
    // arrowhead; only the colour (and the adoptive double-line) differ — see the
    // type-specific blocks below. Single-sourced so blood and adoption can't route apart.
    selector: 'edge[type = "PARENT_OF"], edge[type = "ADOPTIVE_PARENT_OF"]',
    style: {
      "target-arrow-shape": "triangle",
      "curve-style": "taxi",
      "taxi-direction": "rightward",
      "taxi-turn": "50%",
    },
  },
  {
    selector: 'edge[type = "PARENT_OF"]',
    style: { "line-color": "#475569", "target-arrow-color": "#475569" },
  },
  {
    selector: 'edge[type = "SPOUSE_OF"]',
    style: { "line-color": "#db2777", "curve-style": "straight" },
  },
  {
    // Adoption is a parent→child relation (same taxi routing as blood, above), but
    // drawn as a double line in a distinct green to mark it as non-blood. cytoscape
    // has no `line-style: double` for edges, so the doubling is faked with line-outline:
    // a background-coloured core line inside a thin green outline reads as two parallel
    // green strokes.
    selector: 'edge[type = "ADOPTIVE_PARENT_OF"]',
    style: {
      // width = the dark (background-coloured) gap; the green outline draws the two
      // parallel strokes on either side. A thin stroke + moderate gap reads as two
      // crisp parallel lines rather than one thick band.
      width: 4,
      "line-color": "#18181b",
      "line-outline-width": 1,
      "line-outline-color": "#22c55e",
      "target-arrow-color": "#22c55e",
    },
  },
  {
    // Mother→child edges fed to dagre only to co-rank couples (see layoutOnlyEdges).
    // `visibility: hidden` keeps them in the layout pass while not drawing them;
    // `display: none` would exclude them from layout and defeat the purpose.
    selector: 'edge[type = "LAYOUT"]',
    style: { visibility: "hidden" },
  },
];

const SPOUSE_GUTTER = 70; // < rankSep (220): stays in the node-free inter-column gutter

// Read dagre's coordinates into plain data for the layout domain, and write the
// domain's result back. cytoscape is only the graph + coordinate store here; the
// placement/priority rules live in lib/layout.
function readPositions(cy: Core): Positions {
  const pos: Positions = new Map();
  cy.nodes().forEach((n) => {
    pos.set(n.id(), { x: n.position("x"), y: n.position("y") });
  });
  return pos;
}

function writePositions(cy: Core, pos: Positions): void {
  for (const [id, p] of pos) cy.getElementById(id).position(p);
}

// Mounted with a key derived from focus + pathTo: changing either remounts this,
// so state resets to its initial (loading) value without a synchronous setState
// in an effect. With `pathTo` set, it renders the shortest path between the two
// people instead of the ego graph, highlighting both endpoints.
export function GraphPane({
  focus,
  pathTo,
  onSelect,
}: {
  focus: FocusPerson;
  pathTo?: FocusPerson | null;
  onSelect: (person: FocusPerson) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const url = pathTo
      ? `/api/path?from=${encodeURIComponent(focus.qid)}&to=${encodeURIComponent(pathTo.qid)}`
      : `/api/person/${encodeURIComponent(focus.qid)}/neighbors?hops=${HOPS}`;
    const failMsg = pathTo
      ? "経路の取得に失敗しました"
      : "グラフの取得に失敗しました";
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${failMsg} (${res.status})`);
        return (await res.json()) as Graph;
      })
      .then((g) => {
        // Clear a prior failure: re-selecting the same path target re-fires this
        // without a remount (the key is qid-based), so a stale error overlay must
        // not outlive a successful retry.
        setGraph(g);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : failMsg);
      });
    return () => controller.abort();
  }, [focus.qid, pathTo]);

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    // Ego view: collapse to a patrilineal tree (one parent line per child). Path
    // view keeps every edge so the chain between the two people reads end to end.
    const edges = pathTo ? graph.edges : patrilinealEdges(graph);
    // Hidden edges that only steer dagre's ranking, so a married-in spouse sits in
    // their partner's generation column instead of drifting into their own family's.
    // Reuse the patrilineal reduction already in `edges` rather than recomputing it.
    const layoutEdges = pathTo ? [] : layoutOnlyEdges(graph, edges);
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({
        data: {
          id: n.qid,
          label: n.label,
          focus: n.qid === focus.qid || n.qid === pathTo?.qid ? 1 : 0,
        },
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
      container: containerRef.current,
      elements,
      style: STYLE,
    });
    // Flow left→right so each generation is a column and siblings stack
    // vertically — horizontal labels then sit to the right without colliding.
    // Typed via the dagre extension's options so a mistyped key is caught.
    const dagreLR = (
      extra: Partial<cytoscapeDagre.DagreLayoutOptions> = {},
    ): cytoscapeDagre.DagreLayoutOptions => ({
      name: "dagre",
      rankDir: "LR",
      animate: false,
      ...extra,
    });
    if (pathTo) {
      cy.layout(dagreLR()).run(); // small graph: default fit is fine
    } else {
      // Lay out on the descent edges (drawn father→child plus the hidden mother→child
      // layout edges that co-rank couples). A prolific line is genuinely tall; fitting
      // it to the pane shrinks names to nothing, so open at a readable zoom on the
      // focus instead. rankSep leaves room for a name between columns; nodeSep keeps
      // stacked labels apart.
      cy.nodes()
        .union(
          cy.edges(
            '[type = "PARENT_OF"], [type = "LAYOUT"], [type = "ADOPTIVE_PARENT_OF"]',
          ),
        )
        .layout(dagreLR({ nodeSep: NODE_SEP, rankSep: 220, fit: false }))
        .run();
      // The placement/priority rules live in lib/layout as pure functions; this
      // effect is just the cytoscape adapter — read dagre's coordinates, run the
      // rules, write the result back, then apply the spouse-line detours as style.
      const positions = placeNodes(readPositions(cy), edges, focus.qid, ROW);
      writePositions(cy, positions);
      for (const { edgeId, bow } of spouseRouting(
        positions,
        edges,
        SPOUSE_GUTTER,
      )) {
        const e = cy.getElementById(edgeId);
        e.style("curve-style", "segments");
        e.style("segment-weights", "0.08 0.92");
        e.style("segment-distances", `${bow} ${bow}`);
      }
      // Re-root each couple's descent lines at the parents' midpoint: add an
      // invisible junction node there, draw junction→child edges (PARENT_OF so
      // they inherit the taxi descent style), and hide the original father→child
      // edges — which stay in the graph for the layout pass above, just unseen.
      for (const j of descentJunctions(graph, edges, positions, ROW)) {
        cy.add({ data: { id: j.id, junction: 1 } }).position(j.pos);
        for (const child of j.children) {
          cy.add({
            data: {
              id: `${j.id}->${child}`,
              source: j.id,
              target: child,
              type: "PARENT_OF",
            },
          });
        }
        for (const eid of j.hiddenEdgeIds) {
          cy.getElementById(eid).style("visibility", "hidden");
        }
      }
      cy.zoom(0.8);
      cy.center(cy.getElementById(focus.qid));
    }
    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      onSelect({ qid: d.id, label: d.label });
    });
    return () => cy.destroy();
  }, [graph, focus.qid, pathTo, onSelect]);

  const loading = !graph && !error;
  // A path request that finds nothing returns an empty graph (vs. a missing-person
  // 404, which throws above); distinguish it so the user sees a clear message.
  const noPath = !!pathTo && !!graph && graph.nodes.length === 0;

  return (
    <div className="relative h-full w-full bg-zinc-50 dark:bg-zinc-900">
      {loading && (
        <p className="absolute top-3 left-3 z-10 text-sm text-zinc-500">
          {pathTo ? "経路を探索中…" : "グラフを読み込み中…"}
        </p>
      )}
      {error && (
        <p className="absolute top-3 left-3 z-10 text-sm text-red-600">
          {error}
        </p>
      )}
      {noPath && (
        <p className="absolute top-3 left-3 z-10 text-sm text-zinc-500">
          経路が見つかりません
        </p>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
