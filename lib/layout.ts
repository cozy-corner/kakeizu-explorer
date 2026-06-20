import type { Graph, GraphEdge } from "./graph";

// Plain-data view of cytoscape's "graph + coordinates": placement rules operate
// on these instead of touching the renderer, so they're unit-testable. The view
// reads dagre's output into a Positions map, runs these, and writes back.
export type Pos = { x: number; y: number };
export type Positions = Map<string, Pos>; // insertion order mirrors cy.nodes()

const PARENT_TYPES = new Set(["PARENT_OF", "ADOPTIVE_PARENT_OF"]);

// No parent edge (blood or adoptive) incident in either direction = married-in:
// the patrilineal view drops a mother's descent edges, so even a wife with
// children has none. These belong to no parent's block, so they're the only
// nodes placeNodes may move. An adopted child IS placed by its adoptive parent,
// so it must not count as married-in.
export function isMarriedIn(id: string, edges: GraphEdge[]): boolean {
  return !edges.some(
    (edge) =>
      PARENT_TYPES.has(edge.type) && (edge.source === id || edge.target === id),
  );
}

// Spouse partners of `id`, in edge order — the deterministic stand-in for the
// order a cytoscape collection would have yielded.
function spouseNeighbors(id: string, edges: GraphEdge[]): string[] {
  return edges
    .filter(
      (edge) =>
        edge.type === "SPOUSE_OF" && (edge.source === id || edge.target === id),
    )
    .map((edge) => (edge.source === id ? edge.target : edge.source));
}

function pushInto<K>(map: Map<K, string[]>, key: K, value: string): void {
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);
}

function clonePositions(pos: Positions): Positions {
  return new Map([...pos].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

// Keep dagre's vertical positions for blood descendants — gaps and all, since the
// gaps separate one parent's children from the next — so parent blocks stay
// readable. Married-in spouses move: tuck each beside the partner it married,
// preferring the focus when someone married more than one in-tree relative. The
// focus's own spouse is tucked beside the focus too, even when that spouse heads
// their own blood line (so dagre stacked them in their own block).
function packColumns(
  input: Positions,
  edges: GraphEdge[],
  focusId: string,
  row: number,
): Positions {
  const pos = clonePositions(input);
  // isMarriedIn is an O(edges) scan, queried per node and per spouse anchor below;
  // resolve membership once into a set of the present nodes.
  const married = new Set<string>();
  for (const id of pos.keys()) if (isMarriedIn(id, edges)) married.add(id);

  const hostOf = (id: string): string | null => {
    const anchors = spouseNeighbors(id, edges).filter(
      (p) => p !== id && pos.has(p) && !married.has(p),
    );
    if (anchors.length === 0) return null;
    return anchors.find((p) => p === focusId) ?? anchors[0];
  };

  const attached = new Map<string, string[]>();
  for (const [id] of pos) {
    if (!married.has(id)) continue;
    const host = hostOf(id);
    if (!host) continue;
    pushInto(attached, host, id);
    const hp = pos.get(host)!;
    pos.set(id, { x: hp.x, y: hp.y }); // provisional; the spacing walk overwrites y
  }

  // The focus's own spouse should sit beside them, but a spouse who heads their
  // own blood line is not married-in, so the loop above skipped them. Attach each
  // such focus-spouse to the focus so the walk tucks them in (their own co-spouses
  // ride along via the recursive expansion below). Only same-column spouses: one in
  // another column has no shared child co-ranking them beside the focus, and a blood
  // parent/child of the focus is always in an adjacent column anyway (LR layout), so
  // the check also keeps us from pulling blood kin out of their block. No provisional
  // move: such a spouse already shares the focus's column.
  const focus = pos.get(focusId);
  if (focus && !married.has(focusId)) {
    const focusX = Math.round(focus.x);
    for (const sp of spouseNeighbors(focusId, edges)) {
      if (sp === focusId || married.has(sp)) continue;
      const spp = pos.get(sp);
      if (!spp || Math.round(spp.x) !== focusX) continue;
      pushInto(attached, focusId, sp);
    }
  }

  const attachedIds = new Set<string>();
  for (const list of attached.values())
    for (const id of list) attachedIds.add(id);

  const cols = new Map<number, string[]>();
  for (const [id, p] of pos) pushInto(cols, Math.round(p.x), id);

  for (const colIds of cols.values()) {
    const seeds = colIds
      .filter((id) => !attachedIds.has(id))
      .sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);
    // Expand transitively: a tucked-in spouse may itself host co-spouses, so
    // flatten the whole attached chain.
    const order: string[] = [];
    const expand = (id: string): void => {
      order.push(id);
      for (const a of attached.get(id) ?? []) expand(a);
    };
    for (const s of seeds) expand(s);
    // dagre spaces anchors ≥ row apart, so keeping each anchor's own y reproduces a
    // spouse-free column exactly; only a tucked-in spouse pushes the rows below down.
    const x = pos.get(order[0])!.x;
    let prevY = -Infinity;
    for (const id of order) {
      const y = attachedIds.has(id)
        ? prevY + row
        : Math.max(prevY + row, pos.get(id)!.y);
      pos.set(id, { x, y });
      prevY = y;
    }
  }
  return pos;
}

// An adoptive parent of the focus enters dagre via its ADOPTIVE_PARENT_OF edge,
// so it lands in the blood-parent column on the focus's own row — right on top of
// the real father. Drop each below the focus's sibling cluster: still left of the
// focus (parent side, arrow still points right), but clear of the blood-parent
// line. Skip anyone who is ALSO a blood parent of the focus — their line owns that
// column, and moving them would tear the blood tree. (A node that merely parents
// some other in-view person by succession is still moved.)
function placeAdoptiveParents(
  input: Positions,
  edges: GraphEdge[],
  focusId: string,
  row: number,
): Positions {
  const pos = clonePositions(input);
  const focus = pos.get(focusId);
  if (!focus) return pos;
  const bloodParents = new Set(
    edges
      .filter((edge) => edge.type === "PARENT_OF" && edge.target === focusId)
      .map((edge) => edge.source),
  );
  const seen = new Set<string>();
  const parents = edges
    .filter(
      (edge) => edge.type === "ADOPTIVE_PARENT_OF" && edge.target === focusId,
    )
    .map((edge) => edge.source)
    .filter((p) => {
      if (bloodParents.has(p) || !pos.has(p) || seen.has(p)) return false;
      seen.add(p);
      return true;
    });
  if (parents.length === 0) return pos;

  // The sibling cluster is everyone dagre put in the focus's column.
  const focusX = Math.round(focus.x);
  let clusterBottom = -Infinity;
  for (const p of pos.values()) {
    if (Math.round(p.x) === focusX)
      clusterBottom = Math.max(clusterBottom, p.y);
  }
  let y = clusterBottom + row;
  for (const id of parents) {
    pos.set(id, { x: pos.get(id)!.x, y });
    y += row;
  }
  return pos;
}

// Each stage clones its input and returns a new map, so neither mutates the
// caller's positions; the view writes the result back into cytoscape.
export function placeNodes(
  pos: Positions,
  edges: GraphEdge[],
  focusId: string,
  row: number,
): Positions {
  return placeAdoptiveParents(
    packColumns(pos, edges, focusId, row),
    edges,
    focusId,
    row,
  );
}

const BLOCK_Y_MARGIN = 8; // ignore the partners' own rows near each endpoint
const BLOCK_X_RADIUS = 24; // a node within this of the mid-x sits on the line

// Marriage lines stay straight, except one that runs over an UNRELATED person: a
// cross-family/cousin marriage pins both partners to their own blocks, so its line
// spans the column. Report just those, with the bow distance to route them into the
// empty inter-column gutter; the view applies the style. Passing among the person's
// own co-spouses is fine, so co-spouses don't count as in the way. The bow's sign
// follows source→target so it always bends left, clear of the right-hand labels.
export function spouseRouting(
  pos: Positions,
  edges: GraphEdge[],
  spouseGutter: number,
): { edgeId: string; bow: number }[] {
  const nodes = [...pos.entries()];
  // Resolve spouse adjacency once; coSpouses is then an O(1) lookup per edge
  // instead of re-scanning all edges twice inside the loop.
  const spouseAdj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "SPOUSE_OF") continue;
    pushInto(spouseAdj, edge.source, edge.target);
    pushInto(spouseAdj, edge.target, edge.source);
  }
  return edges
    .filter((edge) => edge.type === "SPOUSE_OF")
    .flatMap((edge) => {
      const sp = pos.get(edge.source);
      const tp = pos.get(edge.target);
      if (!sp || !tp) return [];
      const [yLo, yHi] = sp.y < tp.y ? [sp.y, tp.y] : [tp.y, sp.y];
      const x = (sp.x + tp.x) / 2;
      const coSpouses = new Set<string>([
        edge.source,
        edge.target,
        ...(spouseAdj.get(edge.source) ?? []),
        ...(spouseAdj.get(edge.target) ?? []),
      ]);
      const blocked = nodes.some(
        ([id, p]) =>
          !coSpouses.has(id) &&
          p.y > yLo + BLOCK_Y_MARGIN &&
          p.y < yHi - BLOCK_Y_MARGIN &&
          Math.abs(p.x - x) < BLOCK_X_RADIUS,
      );
      if (!blocked) return [];
      const bow = (tp.y > sp.y ? 1 : -1) * spouseGutter;
      return [{ edgeId: `${edge.source}|SPOUSE_OF|${edge.target}`, bow }];
    });
}

// An invisible anchor placed at the midpoint of a couple so the descent line
// sprouts from between the parents (the genealogy T-join) instead of from the
// father alone. The view adds a node at `pos`, draws junction→child edges, and
// hides the original father→child edges by id.
export type DescentJunction = {
  id: string;
  pos: Pos;
  children: string[]; // child ids to connect from the junction
  hiddenEdgeIds: string[]; // father→child PARENT_OF edge ids the junction replaces
};

export const JUNCTION_PREFIX = "__junction__";

// For each drawn father→child line whose child also has exactly one in-view
// mother sharing the father's column, group the children under one junction at
// the parents' midpoint. `graph` is the UNREDUCED graph so a mother dropped by
// the patrilineal view is still recoverable; `drawnEdges` is the reduced set so
// junctions only replace lines actually drawn. Skipped (father→child left alone)
// when parentage is ambiguous — a child with more than one drawn father, or none
// or several in-view mothers, or parents not sharing a column — so an uncertain
// couple never invents a false midpoint.
//
// Polygamy falls back to father-origin too: a father with two or more distinct
// in-view mothers gets NO junctions. The midpoint convention (descent line out of
// the gap between a couple) only reads cleanly for one couple — with the wives
// stacked in one column, a far wife's midpoint lands among the other wives, so it
// no longer says which mother. Traditional Japanese genealogy draws such children
// from the father (mother shown only as a spouse), which this matches.
//
// The mother must also be the father's immediate vertical neighbour (gap ≈ one
// `row`). A mother who heads her own descent isn't tucked beside the father, so
// the couple can sit far apart in the column; their midpoint would then float in
// empty space, reading as a line from nowhere. Only an adjacent pair has a real
// "between" to sprout from — anything farther falls back to father-origin.
export function descentJunctions(
  graph: Graph,
  drawnEdges: GraphEdge[],
  positions: Positions,
  row: number,
): DescentJunction[] {
  const sex = new Map(graph.nodes.map((n) => [n.qid, n.sex]));
  const parentsOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type === "PARENT_OF") pushInto(parentsOf, e.target, e.source);
  }
  const drawnFathersOf = new Map<string, string[]>();
  for (const e of drawnEdges) {
    if (e.type === "PARENT_OF") pushInto(drawnFathersOf, e.target, e.source);
  }

  const byCouple = new Map<
    string,
    { father: string; junction: DescentJunction }
  >();
  const mothersByFather = new Map<string, Set<string>>();
  for (const e of drawnEdges) {
    if (e.type !== "PARENT_OF") continue;
    const child = e.target;
    const father = e.source;
    if ((drawnFathersOf.get(child) ?? []).length !== 1) continue;
    const fp = positions.get(father);
    if (!fp) continue;
    const mothers = (parentsOf.get(child) ?? []).filter(
      (p) => sex.get(p) === "female" && positions.has(p) && p !== father,
    );
    if (mothers.length !== 1) continue;
    const mp = positions.get(mothers[0])!;
    if (Math.round(mp.x) !== Math.round(fp.x)) continue; // not a co-located couple
    // Count co-located mothers BEFORE the adjacency gate so polygamy is detected
    // even when a second wife sits far down the column (and would be gated out).
    (
      mothersByFather.get(father) ??
      mothersByFather.set(father, new Set()).get(father)!
    ).add(mothers[0]);
    if (Math.abs(mp.y - fp.y) > row * 1.5) continue; // not an adjacent pair
    const key = `${father}|${mothers[0]}`;
    const entry = byCouple.get(key) ?? {
      father,
      junction: {
        id: `${JUNCTION_PREFIX}|${father}|${mothers[0]}`,
        pos: { x: fp.x, y: (fp.y + mp.y) / 2 },
        children: [],
        hiddenEdgeIds: [],
      },
    };
    entry.junction.children.push(child);
    entry.junction.hiddenEdgeIds.push(`${father}|PARENT_OF|${child}`);
    byCouple.set(key, entry);
  }
  return [...byCouple.values()]
    .filter(({ father }) => mothersByFather.get(father)!.size === 1)
    .map(({ junction }) => junction);
}
