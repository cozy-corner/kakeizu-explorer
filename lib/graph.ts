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

// Every node appears at least once in the `a` columns, so building nodes from
// `a` alone is complete; `b`/type are null when `a` has no in-subgraph edge.
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
