"use client";

import cytoscape, {
  type Core,
  type ElementDefinition,
  type NodeSingular,
} from "cytoscape";
import dagre from "cytoscape-dagre";
import type * as cytoscapeDagre from "cytoscape-dagre";
import { useEffect, useRef, useState } from "react";
import { layoutOnlyEdges, patrilinealEdges, type Graph } from "@/lib/graph";

cytoscape.use(dagre);

export type FocusPerson = { qid: string; label: string };

const HOPS = 2;

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
      width: 16,
      height: 16,
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
    selector: "edge",
    style: { width: 1.5, "curve-style": "bezier", "line-color": "#cbd5e1" },
  },
  {
    selector: 'edge[type = "PARENT_OF"]',
    style: {
      "line-color": "#475569",
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#475569",
      "curve-style": "taxi",
      "taxi-direction": "rightward",
      "taxi-turn": "50%",
    },
  },
  {
    selector: 'edge[type = "SPOUSE_OF"]',
    style: { "line-color": "#db2777", "curve-style": "straight" },
  },
  {
    // Mother→child edges fed to dagre only to co-rank couples (see layoutOnlyEdges).
    // `visibility: hidden` keeps them in the layout pass while not drawing them;
    // `display: none` would exclude them from layout and defeat the purpose.
    selector: 'edge[type = "LAYOUT"]',
    style: { visibility: "hidden" },
  },
];

// A married-in spouse (e.g. a wife) has no PARENT_OF edge of her own, so dagre
// strands her at the top rank. Re-seat each such node in the partner's generation
// column (LR layout), stacked just above them; multiple spouses fan upward so they
// don't pile on one point.
function placeMarriedInSpouses(cy: Core): void {
  const placed = new Map<string, number>(); // partner id → spouses already seated
  cy.nodes().forEach((n) => {
    if (n.connectedEdges('[type = "PARENT_OF"]').nonempty()) return;
    const partners = n
      .connectedEdges('[type = "SPOUSE_OF"]')
      .connectedNodes()
      .filter(
        (p) =>
          p.id() !== n.id() &&
          p.connectedEdges('[type = "PARENT_OF"]').nonempty(),
      );
    if (partners.empty()) return;
    // filter() widens to a mixed collection; first() is a node here by construction.
    const partner = partners.first() as NodeSingular;
    const k = placed.get(partner.id()) ?? 0;
    placed.set(partner.id(), k + 1);
    const pos = partner.position();
    n.position({ x: pos.x, y: pos.y - 40 * (k + 1) });
  });
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
    const layoutEdges = pathTo ? [] : layoutOnlyEdges(graph);
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
      // Lay out the tree on the descent edges (drawn father→child plus the hidden
      // mother→child layout edges that co-rank couples), then re-seat any spouse
      // still left edgeless. A prolific line is genuinely tall; fitting it to the
      // pane shrinks names to nothing, so open at a readable zoom on the focus
      // instead. rankSep leaves room for a name between columns; nodeSep keeps
      // stacked labels apart.
      cy.nodes()
        .union(cy.edges('[type = "PARENT_OF"], [type = "LAYOUT"]'))
        .layout(dagreLR({ nodeSep: 30, rankSep: 220, fit: false }))
        .run();
      placeMarriedInSpouses(cy);
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
