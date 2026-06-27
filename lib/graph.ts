// A person's Wikidata QID, branded so it can't be mixed up with a JunctionId — the
// synthetic id of a couple's midpoint node. The layout's coordinate maps are keyed
// by PersonId; the brand stops a junction id (a cytoscape-only address) being used
// as a key. Raw DB rows carry plain strings; the brand is applied once at the layout
// boundary (buildFamilyGraph / the view's readPositions), never sprinkled around.
export type PersonId = string & { readonly __brand: "PersonId" };
export type JunctionId = string & { readonly __brand: "JunctionId" };

// Wikidata P21 as the ETL stores it: male/female, with anything else (intersex,
// trans, …) collapsed to "other" — see scripts/etl-spike/add-sex.ts. Absent ⇒
// undefined. The patrilineal reduction tests `!== "female"`, so male/other/unknown
// are all father candidates.
export type Sex = "male" | "female" | "other";

// A recorded blood/marriage/adoption relationship (a Neo4j relationship type).
// SIBLING_OF only surfaces in the path view; the ego layout never sees it.
export type Kinship =
  | "PARENT_OF"
  | "SPOUSE_OF"
  | "ADOPTIVE_PARENT_OF"
  | "SIBLING_OF";
// Non-kinship edges the layout/view synthesise: LAYOUT is a hidden edge that only
// steers dagre's ranking; DESCENT is the junction→child line from a couple's
// midpoint. Neither is a relationship.
export type SyntheticEdge = "LAYOUT" | "DESCENT";

export type PersonRow = { qid: string; label: string };

export type GraphNode = { qid: string; label: string; sex?: Sex };
// A domain edge carries a kinship type, or the hidden LAYOUT type when fed to dagre.
// DESCENT (the other SyntheticEdge) is built straight into cytoscape by the view and
// never exists as a GraphEdge. source/target are raw QIDs — branded only once they
// cross into the layout via buildFamilyGraph.
export type GraphEdge = {
  source: string;
  target: string;
  type: Kinship | "LAYOUT";
};
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

// The sole constructor for a JunctionId — the cytoscape id of the invisible anchor
// at a couple's midpoint. Single-sourced (it was an exported const, then briefly an
// inline build in two files) so the live view and the offline dump-layout tool emit
// byte-identical ids; a drift would silently desync the layout-debug dump.
export const JUNCTION_PREFIX = "__junction__";
export const junctionId = (father: PersonId, mother: PersonId): JunctionId =>
  `${JUNCTION_PREFIX}|${father}|${mother}` as JunctionId;

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

// Adoptive edges between siblings — the two people share a blood parent, so they
// are the same generation (e.g. 頼職→吉宗, both 光貞's sons). This is 家督 succession
// recorded as adoption, not a line of descent, so callers drop it from the edge
// set entirely: drawn it would be a same-generation vertical line / a false second
// descent into a child the blood line already places, and fed to dagre it would
// rank the adopted sibling a generation below the other. A cross-generation
// adoption (uncle→nephew 斉彊→家茂, or any pair not sharing a parent) is a genuine
// descent and is kept. (A same-generation adoption between non-siblings — cousins
// — is not detected here, but is vanishingly rare in the data.)
export function siblingAdoptiveEdges(edges: GraphEdge[]): GraphEdge[] {
  const bloodParents = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== "PARENT_OF") continue;
    (bloodParents.get(e.target) ?? addKey(bloodParents, e.target)).add(
      e.source,
    );
  }
  const shareParent = (a: string, b: string): boolean => {
    const pa = bloodParents.get(a);
    const pb = bloodParents.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };
  return edges.filter(
    (e) => e.type === "ADOPTIVE_PARENT_OF" && shareParent(e.source, e.target),
  );
}

function addKey(map: Map<string, Set<string>>, key: string): Set<string> {
  const set = new Set<string>();
  map.set(key, set);
  return set;
}

// The edges the ego (focused-person) view draws: the patrilineal reduction minus
// sibling adoptions. Sibling 養子 (家督 succession between blood siblings) is dropped
// entirely so it neither draws a false second descent nor over-ranks the focus
// below its own sibling in dagre — see siblingAdoptiveEdges. Keyed by value, not
// object identity, so it survives siblingAdoptiveEdges returning fresh edge objects.
export function egoDrawnEdges(graph: Graph): GraphEdge[] {
  const drawn = patrilinealEdges(graph);
  const key = (e: GraphEdge) => `${e.source}|${e.type}|${e.target}`;
  const skip = new Set(siblingAdoptiveEdges(drawn).map(key));
  return drawn.filter((e) => !skip.has(key(e)));
}

// Resolved kinship indices for one ego view, built once at the layout boundary so
// the placement passes read father/spouse/adoptive lookups instead of each
// re-scanning edges (coLocatedCouples alone used to re-derive them on every call).
//
// `graph` is the UNREDUCED ego graph; `drawnEdges` is the patrilineal-reduced,
// sibling-adoption-stripped set the passes actually draw and pack on. The two are
// kept apart on purpose: `trueParentsOf` reads the unreduced graph so a mother the
// patrilineal view dropped is still recoverable (side-wife / couple-midpoint), while
// `fatherOf` reads the drawn set so it only spans lines actually rendered.
export type FamilyGraph = {
  sex: Map<PersonId, Sex | undefined>;
  fatherOf: Map<PersonId, PersonId[]>; // drawn PARENT_OF: child → fathers
  trueParentsOf: Map<PersonId, PersonId[]>; // unreduced PARENT_OF: child → parents (mothers incl.)
  spouseOf: Map<PersonId, PersonId[]>; // drawn SPOUSE_OF: symmetric adjacency, edge order
  spousePairs: { source: PersonId; target: PersonId }[]; // drawn SPOUSE_OF, directed, edge order
  adoptiveParentOf: Map<PersonId, PersonId[]>; // drawn ADOPTIVE_PARENT_OF: child → adoptive parents
  isMarriedIn: (id: PersonId) => boolean;
};

// Append to a multimap, creating the bucket on first use. Shared with lib/layout.
export function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);
}

export function buildFamilyGraph(
  graph: Graph,
  drawnEdges: GraphEdge[],
): FamilyGraph {
  // The brand boundary: raw QID strings on graph/drawnEdges become PersonId as they
  // enter the layout's keyed maps. One cast per kind of ingress, nowhere else.
  const sex = new Map<PersonId, Sex | undefined>(
    graph.nodes.map((n) => [n.qid as PersonId, n.sex]),
  );

  const trueParentsOf = new Map<PersonId, PersonId[]>();
  for (const e of graph.edges) {
    if (e.type === "PARENT_OF")
      pushInto(trueParentsOf, e.target as PersonId, e.source as PersonId);
  }

  const fatherOf = new Map<PersonId, PersonId[]>();
  const spouseOf = new Map<PersonId, PersonId[]>();
  const spousePairs: { source: PersonId; target: PersonId }[] = [];
  const adoptiveParentOf = new Map<PersonId, PersonId[]>();
  // No parent edge (blood or adoptive) incident in either direction ⇒ married-in:
  // the patrilineal view drops a mother's descent edges, so even a wife with
  // children has none, and such nodes belong to no parent's block — they're the
  // only ones placeNodes may move. An adopted child has an ADOPTIVE_PARENT_OF in,
  // so it is NOT married-in (its adoptive parent places it).
  const hasParentEdge = new Set<PersonId>();
  for (const e of drawnEdges) {
    const source = e.source as PersonId;
    const target = e.target as PersonId;
    if (e.type === "PARENT_OF") {
      pushInto(fatherOf, target, source);
      hasParentEdge.add(source).add(target);
    } else if (e.type === "SPOUSE_OF") {
      pushInto(spouseOf, source, target);
      pushInto(spouseOf, target, source);
      spousePairs.push({ source, target });
    } else if (e.type === "ADOPTIVE_PARENT_OF") {
      pushInto(adoptiveParentOf, target, source);
      hasParentEdge.add(source).add(target);
    }
  }

  return {
    sex,
    fatherOf,
    trueParentsOf,
    spouseOf,
    spousePairs,
    adoptiveParentOf,
    isMarriedIn: (id) => !hasParentEdge.has(id),
  };
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
      sex: (row.aSex ?? undefined) as Sex | undefined,
    });
    if (row.type && row.bQid && row.bLabel) {
      nodes.set(row.bQid, {
        qid: row.bQid,
        label: row.bLabel,
        sex: (row.bSex ?? undefined) as Sex | undefined,
      });
      const key = `${row.aQid}|${row.type}|${row.bQid}`;
      edges.set(key, {
        source: row.aQid,
        target: row.bQid,
        type: row.type as Kinship,
      });
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
      type: row.type as Kinship,
    });
  }
  return { nodes: [...nodes.values()], edges };
}
