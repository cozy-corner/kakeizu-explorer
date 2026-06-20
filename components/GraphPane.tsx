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

// No parent edge (blood or adoptive) = married-in: the patrilineal view drops a
// mother's descent edges, so even a wife with children has none. These belong to no
// parent's block, so they're the only nodes packColumns may move. An adopted child
// IS placed by its adoptive parent, so it must not count as married-in.
const isMarriedIn = (n: NodeSingular): boolean =>
  n
    .connectedEdges('[type = "PARENT_OF"], [type = "ADOPTIVE_PARENT_OF"]')
    .empty();

// Keep dagre's vertical positions for blood descendants — gaps and all, since the
// gaps are what separate one parent's children from the next — so parent blocks stay
// readable. Married-in spouses move: tuck each beside the partner it married,
// preferring the focus when someone married more than one in-tree relative. The
// focus's own spouse is tucked beside the focus too, even when that spouse heads their
// own blood line (so dagre stacked them in their own block) — see the focus-spouse
// block below.
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
    n.position(host.position()); // provisional; overwritten by the spacing walk below
  });

  // The focus's own spouse should sit beside them, but a spouse who heads their own
  // blood line is not married-in, so the loop above skipped them. Attach each such
  // focus-spouse to the focus so the spacing walk tucks them in like a married-in
  // partner (their own married-in co-spouses ride along via the recursive expansion
  // below). Only tuck a spouse in the focus's own generation column: a spouse in
  // another column has no shared child co-ranking them beside the focus, and a blood
  // parent/child of the focus is always in an adjacent column anyway (LR layout), so
  // the same-column check also keeps us from pulling blood kin out of their block. A
  // married-in focus is already tucked beside its host, so there is nothing to do.
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
    // Expand transitively: a tucked-in spouse may itself host co-spouses (e.g. the
    // focus's spouse who has another wife), so flatten the whole attached chain.
    const expand = (n: NodeSingular): void => {
      order.push(n);
      for (const a of attached.get(n.id()) ?? []) expand(a);
    };
    for (const s of seeds) expand(s);
    // dagre spaces anchors ≥ ROW apart, so keeping each anchor's own y reproduces a
    // spouse-free column exactly; only a tucked-in spouse pushes the rows below down.
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

// An adoptive parent of the focus enters the dagre ranking via its
// ADOPTIVE_PARENT_OF edge, so it lands in the blood-parent column on the focus's
// own row — right on top of the real father, so the green and grey lines overlap.
// Drop each below the focus's sibling cluster: still left of the focus (parent
// side, arrow still points right), but clear of the blood-parent line. Skip anyone
// who is ALSO a blood parent of the focus — their grey line owns that column, and
// moving them would tear the blood tree. (A node that merely parents some other
// in-view person, e.g. 家茂→家達 by 家督 succession, is still moved.)
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
  // The sibling cluster is everyone dagre put in the focus's column.
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

// Marriage lines stay straight, except one that runs over an UNRELATED person: a
// cross-family/cousin marriage pins both partners to their own blocks, so its line
// spans the column. Route just those into the empty inter-column gutter. Passing
// among the person's own co-spouses is fine, so co-spouses don't count as in the
// way. segment-distances is perpendicular to source→target — normalize its sign so
// the bow always goes left, clear of the right-hand labels.
function routeSpouseEdges(cy: Core): void {
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
    e.style("curve-style", "segments");
    e.style("segment-weights", "0.08 0.92");
    e.style("segment-distances", `${d} ${d}`);
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
      packColumns(cy, focus.qid);
      placeAdoptiveParents(cy, focus.qid);
      routeSpouseEdges(cy);
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
