export type PersonRow = { qid: string; label: string };

export type GraphNode = { qid: string; label: string; sex?: string };
export type GraphEdge = { source: string; target: string; type: string };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

// Reduce a neighbourhood toward a patrilineal tree: the line of descent runs
// through fathers, mothers are shown as the father's spouse (not as a second
// descent line). For each child keep every father edge — a parent whose sex
// isn't "female" (male, or unknown so we don't hide a real father). A child with
// two recorded fathers (e.g. disputed/uncertain parentage) keeps BOTH rather
// than arbitrarily picking one — avoiding a non-deterministic choice and an
// orphaned parent. Mother→child edges are dropped; instead the mother is linked
// to the father by SPOUSE_OF so she sits beside him. When no marriage is
// recorded, sharing a child is treated as one (co-parent ⇒ couple) so a
// spouse-less mother (e.g. an unrecorded concubine) doesn't float. If no father
// is known at all, keep every parent so the child isn't orphaned. Sibling links
// are always dropped (siblings share a parent column).
export function patrilinealEdges(graph: Graph): GraphEdge[] {
  const sex = new Map(graph.nodes.map((n) => [n.qid, n.sex]));
  const parentsOf = new Map<string, string[]>();
  const spouse: GraphEdge[] = [];
  // Adoptive parent→child edges pass through untouched: they're a separate layer
  // (drawn as a double line), not part of the patrilineal blood-descent reduction,
  // and deliberately don't influence the father/mother/couple logic.
  const adoptive: GraphEdge[] = [];
  const couple = new Set<string>(); // unordered pairs already linked as spouses
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const e of graph.edges) {
    if (e.type === "PARENT_OF") {
      const list = parentsOf.get(e.target) ?? [];
      list.push(e.source);
      parentsOf.set(e.target, list);
    } else if (e.type === "SPOUSE_OF") {
      spouse.push(e);
      couple.add(pairKey(e.source, e.target));
    } else if (e.type === "ADOPTIVE_PARENT_OF") {
      adoptive.push(e);
    }
  }
  const structural: GraphEdge[] = [];
  for (const [child, parents] of parentsOf) {
    const fathers = parents.filter((p) => sex.get(p) !== "female");
    if (fathers.length === 0) {
      for (const p of parents) {
        structural.push({ source: p, target: child, type: "PARENT_OF" });
      }
      continue;
    }
    for (const f of fathers) {
      structural.push({ source: f, target: child, type: "PARENT_OF" });
    }
    for (const m of parents) {
      if (sex.get(m) !== "female") continue;
      const father = fathers[0];
      if (!couple.has(pairKey(m, father))) {
        couple.add(pairKey(m, father));
        spouse.push({ source: father, target: m, type: "SPOUSE_OF" });
      }
    }
  }
  return [...structural, ...spouse, ...adoptive];
}

// The parent→child edges that the patrilineal view drops from DRAWING (a mother's
// descent line) but the LAYOUT still needs. Feeding these to dagre (hidden, type
// "LAYOUT") co-ranks a couple that shares a visible child: the mother is pulled
// into the father's generation column instead of floating off in her own family's
// column, and children land one column to the right of BOTH parents. Derived as
// "every PARENT_OF edge minus the ones patrilinealEdges keeps", so it tracks the
// reduction rules automatically. Callers that already computed the drawn edges
// pass them in to avoid reducing the same graph twice.
export function layoutOnlyEdges(
  graph: Graph,
  drawnEdges: GraphEdge[] = patrilinealEdges(graph),
): GraphEdge[] {
  const drawn = new Set(
    drawnEdges
      .filter((e) => e.type === "PARENT_OF")
      .map((e) => `${e.source}|${e.target}`),
  );
  return graph.edges
    .filter(
      (e) => e.type === "PARENT_OF" && !drawn.has(`${e.source}|${e.target}`),
    )
    .map((e) => ({ source: e.source, target: e.target, type: "LAYOUT" }));
}

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
  aSex: string | null;
  type: string | null;
  bQid: string | null;
  bLabel: string | null;
  bSex: string | null;
};

export function neighborsToGraph(rows: NeighborRow[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const row of rows) {
    nodes.set(row.aQid, {
      qid: row.aQid,
      label: row.aLabel,
      sex: row.aSex ?? undefined,
    });
    if (row.type && row.bQid && row.bLabel) {
      nodes.set(row.bQid, {
        qid: row.bQid,
        label: row.bLabel,
        sex: row.bSex ?? undefined,
      });
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
