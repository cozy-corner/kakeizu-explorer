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

// Mounted with key={focus.qid}: a focus change remounts this, so state resets
// to its initial (loading) value without a synchronous setState in an effect.
export function GraphPane({
  focus,
  onSelect,
}: {
  focus: FocusPerson;
  onSelect: (person: FocusPerson) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `/api/person/${encodeURIComponent(focus.qid)}/neighbors?hops=${HOPS}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok)
          throw new Error(`グラフの取得に失敗しました (${res.status})`);
        return (await res.json()) as Graph;
      })
      .then(setGraph)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "グラフの取得に失敗しました",
        );
      });
    return () => controller.abort();
  }, [focus.qid]);

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({
        data: { id: n.qid, label: n.label, focus: n.qid === focus.qid ? 1 : 0 },
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
  }, [graph, focus.qid, onSelect]);

  const loading = !graph && !error;

  return (
    <div className="relative h-full w-full bg-zinc-50 dark:bg-zinc-900">
      {loading && (
        <p className="absolute top-3 left-3 z-10 text-sm text-zinc-500">
          グラフを読み込み中…
        </p>
      )}
      {error && (
        <p className="absolute top-3 left-3 z-10 text-sm text-red-600">
          {error}
        </p>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
