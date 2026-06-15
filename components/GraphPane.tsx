"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useRef, useState } from "react";
import type { Graph } from "@/lib/graph";

export type FocusPerson = { qid: string; label: string };

const HOPS = 2;

// Colour edges by relationship so parent/spouse/sibling links read at a glance.
// PARENT_OF keeps its direction (arrow); spouse/sibling are undirected.
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
      "text-valign": "bottom",
      "text-margin-y": 2,
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
    },
  },
  { selector: 'edge[type = "SPOUSE_OF"]', style: { "line-color": "#db2777" } },
  { selector: 'edge[type = "SIBLING_OF"]', style: { "line-color": "#0891b2" } },
];

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
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({
        data: {
          id: n.qid,
          label: n.label,
          focus: n.qid === focus.qid || n.qid === pathTo?.qid ? 1 : 0,
        },
      })),
      ...graph.edges.map((e) => ({
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
      layout: { name: "cose", animate: false },
    });
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
