"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { useEffect, useRef, useState } from "react";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  junctionId,
  layoutOnlyEdges,
  type Graph,
  type PersonId,
  type SyntheticEdge,
} from "@/lib/graph";
import {
  centerOnlyChildren,
  descentJunctions,
  placeNodes,
  project,
  projectOne,
  readPlacement,
  spouseRouting,
  type Positions,
} from "@/lib/layout";
import { dagreLR, ROW, runEgoLayout, SPOUSE_GUTTER, STYLE } from "@/lib/render";

cytoscape.use(dagre);

export type FocusPerson = { qid: string; label: string };

const HOPS = 2;

// Read dagre's coordinates into plain data for the layout domain, and write the
// domain's result back. cytoscape is only the graph + coordinate store here; the
// placement/priority rules live in lib/layout.
function readPositions(cy: Core): Positions {
  const pos: Positions = new Map();
  cy.nodes().forEach((n) => {
    // Every layout node is a person here (junctions are added after this read), so
    // brand the cytoscape id as a PersonId at this single boundary.
    pos.set(n.id() as PersonId, { x: n.position("x"), y: n.position("y") });
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
    // Ego view: collapse to the drawn patrilineal tree (see egoDrawnEdges). Path
    // view keeps every edge so the chain between the two people reads end to end.
    const edges = pathTo ? graph.edges : egoDrawnEdges(graph);
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
    if (pathTo) {
      cy.layout(dagreLR()).run(); // small graph: default fit is fine
    } else {
      runEgoLayout(cy);
      // The placement/priority rules live in lib/layout as pure functions; this
      // effect is just the cytoscape adapter — read dagre's coordinates into the
      // structural {col, order} space, run the rules, project back to pixels and
      // write them, then apply the spouse-line detours as style. ROW is injected
      // only at the read/project boundary; the passes themselves carry no pixels.
      // Resolve kinship once and hand the same FamilyGraph to every pass.
      const fam = buildFamilyGraph(graph, edges);
      const focusId = focus.qid as PersonId;
      const { placements, colX } = readPlacement(readPositions(cy), ROW);
      const placed = centerOnlyChildren(
        placeNodes(placements, fam, focusId),
        fam,
        focusId,
      );
      const positions = project(placed, colX, ROW);
      writePositions(cy, positions);
      for (const { source, target, bow } of spouseRouting(
        positions,
        fam,
        SPOUSE_GUTTER,
      )) {
        const e = cy.getElementById(`${source}|SPOUSE_OF|${target}`);
        e.style("curve-style", "segments");
        e.style("segment-weights", "0.08 0.92");
        e.style("segment-distances", `${bow} ${bow}`);
      }
      // Re-root each couple's descent lines at the parents' midpoint: add an
      // invisible junction node there, draw junction→child DESCENT edges (a
      // distinct type, styled like PARENT_OF, that never aliases a real person
      // edge), and hide the original father→child edges — which stay in the graph
      // for the layout pass above, just unseen.
      for (const j of descentJunctions(fam, placed)) {
        const jid = junctionId(j.father, j.mother);
        cy.add({ data: { id: jid, junction: 1 } }).position(
          projectOne(j.pos, colX, ROW),
        );
        for (const child of j.children) {
          cy.add({
            data: {
              id: `${jid}->${child}`,
              source: jid,
              target: child,
              type: "DESCENT" satisfies SyntheticEdge,
            },
          });
          // Hide the father→child edge this junction replaces (its cytoscape id is
          // the same `source|type|target` the elements were built with above).
          cy.getElementById(`${j.father}|PARENT_OF|${child}`).style(
            "visibility",
            "hidden",
          );
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
