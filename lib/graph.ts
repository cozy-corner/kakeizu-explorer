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

// One row per relationship along the path, in path order. Source/target follow
// each edge's stored direction (PARENT_OF), independent of traversal direction,
// so the arrow renders correctly. Nodes are deduped by qid; their array order
// roughly tracks the path but isn't guaranteed (a reversed-direction edge swaps
// a pair) — nothing relies on it, cytoscape lays the graph out itself.
export type PathRow = {
  sourceQid: string;
  sourceLabel: string;
  targetQid: string;
  targetLabel: string;
  type: string;
};

export function pathToGraph(rows: PathRow[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const row of rows) {
    nodes.set(row.sourceQid, { qid: row.sourceQid, label: row.sourceLabel });
    nodes.set(row.targetQid, { qid: row.targetQid, label: row.targetLabel });
    edges.push({
      source: row.sourceQid,
      target: row.targetQid,
      type: row.type,
    });
  }
  return { nodes: [...nodes.values()], edges };
}
