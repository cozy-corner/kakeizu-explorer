export type PersonRow = { qid: string; label: string };

export type GraphNode = { qid: string; label: string };
export type GraphEdge = { source: string; target: string; type: string };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

// edges is always empty: search returns people, not relationships.
export function personsToGraph(rows: PersonRow[]): Graph {
  return {
    nodes: rows.map((r) => ({ qid: r.qid, label: r.label })),
    edges: [],
  };
}

// One row per subgraph node `a`, with its outgoing in-subgraph edge to `b`
// (null columns when `a` has none — e.g. an isolated focus person). The
// neighbors query returns every node at least once in the `a` columns, so the
// focus person survives even with zero relationships.
export type NeighborRow = {
  aQid: string;
  aLabel: string;
  type: string | null;
  bQid: string | null;
  bLabel: string | null;
};

export function neighborsToGraph(rows: NeighborRow[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const row of rows) {
    nodes.set(row.aQid, { qid: row.aQid, label: row.aLabel });
    if (row.type && row.bQid && row.bLabel) {
      nodes.set(row.bQid, { qid: row.bQid, label: row.bLabel });
      const key = `${row.aQid}|${row.type}|${row.bQid}`;
      edges.set(key, { source: row.aQid, target: row.bQid, type: row.type });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
