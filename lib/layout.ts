import { pushInto, type FamilyGraph } from "./graph";

// Plain-data view of cytoscape's "graph + coordinates": placement rules operate
// on these instead of touching the renderer, so they're unit-testable. The view
// reads dagre's output into a Positions map, runs these, and writes back.
export type Pos = { x: number; y: number };
export type Positions = Map<string, Pos>; // insertion order mirrors cy.nodes()

function addInto<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
}

function clonePositions(pos: Positions): Positions {
  return new Map([...pos].map(([id, p]) => [id, { x: p.x, y: p.y }]));
}

// Resolve who tucks beside whom, as host → its directly-attached spouse ids:
// a married-in spouse rides beside the in-tree partner it married (preferring the
// focus when it married more than one in-tree relative), and the focus's own
// spouse rides beside the focus even when that spouse heads their own blood line.
// Transitive co-spouses are reached by walking the map (a tucked spouse may host
// its own). Depends only on edges, the present node set, and the focus column —
// not on y — so it's stable across the y-repacking, letting both packColumns and
// centerOnlyChildren derive their mover sets from one definition (the two used to
// re-derive it separately and drift apart).
function tuckHosts(
  pos: Positions,
  fam: FamilyGraph,
  focusId: string,
): Map<string, string[]> {
  const hostOf = (id: string): string | null => {
    const anchors = (fam.spouseOf.get(id) ?? []).filter(
      (p) => p !== id && pos.has(p) && !fam.isMarriedIn(p),
    );
    if (anchors.length === 0) return null;
    return anchors.find((p) => p === focusId) ?? anchors[0];
  };

  const attached = new Map<string, string[]>();
  for (const [id] of pos) {
    if (!fam.isMarriedIn(id)) continue;
    const host = hostOf(id);
    if (!host) continue;
    pushInto(attached, host, id);
  }

  // The focus's own spouse should sit beside them, but a spouse who heads their
  // own blood line is not married-in, so the loop above skipped them. Attach each
  // such focus-spouse to the focus so the walk tucks them in. Only same-column
  // spouses: one in another column has no shared child co-ranking them beside the
  // focus, and a blood parent/child of the focus is always in an adjacent column
  // anyway (LR layout), so the check also keeps us from pulling blood kin out of
  // their block.
  const focus = pos.get(focusId);
  if (focus && !fam.isMarriedIn(focusId)) {
    const focusX = Math.round(focus.x);
    for (const sp of fam.spouseOf.get(focusId) ?? []) {
      if (sp === focusId || fam.isMarriedIn(sp)) continue;
      const spp = pos.get(sp);
      if (!spp || Math.round(spp.x) !== focusX) continue;
      pushInto(attached, focusId, sp);
    }
  }
  return attached;
}

// Flatten a host's tuck chain in DFS pre-order, host first: a tucked-in spouse
// may itself host co-spouses, so this walks the whole `attached` subtree. Shared
// so packColumns (the spacing walk) and centerOnlyChildren (the mover block)
// always pack the same set — the divergence that re-derived movers caused in #30.
function tuckChain(attached: Map<string, string[]>, root: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>(); // a reverse-direction SPOUSE_OF can list a
  // partner twice; visit each once so the spacing walk doesn't insert a phantom row
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    for (const a of attached.get(id) ?? []) walk(a);
  };
  walk(root);
  return chain;
}

// Keep dagre's vertical positions for blood descendants — gaps and all, since the
// gaps separate one parent's children from the next — so parent blocks stay
// readable. Married-in spouses move: tuck each beside the partner it married,
// preferring the focus when someone married more than one in-tree relative. The
// focus's own spouse is tucked beside the focus too, even when that spouse heads
// their own blood line (so dagre stacked them in their own block).
function packColumns(
  input: Positions,
  fam: FamilyGraph,
  focusId: string,
  row: number,
): Positions {
  const pos = clonePositions(input);
  const attached = tuckHosts(pos, fam, focusId);

  // Provisional: pull each tucked spouse into its host's column so the column
  // grouping below processes it there; the spacing walk overwrites both coords.
  // A focus-spouse already shares the focus's column, so this is a no-op for it.
  for (const [host, ids] of attached) {
    const hp = pos.get(host)!;
    for (const id of ids) pos.set(id, { x: hp.x, y: hp.y });
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
    const order = seeds.flatMap((s) => tuckChain(attached, s));
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
  fam: FamilyGraph,
  focusId: string,
  row: number,
): Positions {
  const pos = clonePositions(input);
  const focus = pos.get(focusId);
  if (!focus) return pos;
  const bloodParents = new Set(fam.fatherOf.get(focusId) ?? []);
  const seen = new Set<string>();
  const parents = (fam.adoptiveParentOf.get(focusId) ?? []).filter((p) => {
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
  fam: FamilyGraph,
  focusId: string,
  row: number,
): Positions {
  return placeAdoptiveParents(
    packColumns(pos, fam, focusId, row),
    fam,
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
  fam: FamilyGraph,
  spouseGutter: number,
): { edgeId: string; bow: number }[] {
  const nodes = [...pos.entries()];
  return fam.spousePairs.flatMap((edge) => {
    const sp = pos.get(edge.source);
    const tp = pos.get(edge.target);
    if (!sp || !tp) return [];
    const [yLo, yHi] = sp.y < tp.y ? [sp.y, tp.y] : [tp.y, sp.y];
    const x = (sp.x + tp.x) / 2;
    const coSpouses = new Set<string>([
      edge.source,
      edge.target,
      ...(fam.spouseOf.get(edge.source) ?? []),
      ...(fam.spouseOf.get(edge.target) ?? []),
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

// A co-located couple and the drawn children that hang from their midpoint. The
// shared resolution behind both the rendered junction and the only-child centering
// nudge, so the two always agree on which couples qualify.
type CoupleGroup = {
  father: string;
  mother: string;
  children: string[];
  mid: Pos;
};

// For each drawn father→child line whose child also has exactly one in-view
// mother sharing the father's column, group the children under their parents'
// midpoint. `fam.trueParentsOf` is the UNREDUCED parentage so a mother dropped by
// the patrilineal view is still recoverable; `fam.fatherOf` is the reduced set so
// this covers only lines actually drawn. Skipped (father→child left alone) when
// parentage is
// ambiguous — a child with more than one drawn father, or none or several in-view
// mothers, or parents not sharing a column — so an uncertain couple never invents
// a false midpoint.
//
// Polygamy falls back to father-origin too: a father with two or more distinct
// in-view mothers is dropped. The midpoint convention (descent out of the gap
// between a couple) only reads cleanly for one couple — with the wives stacked in
// one column, a far wife's midpoint lands among the other wives, so it no longer
// says which mother. Traditional Japanese genealogy draws such children from the
// father (mother shown only as a spouse), which this matches.
//
// The mother must also be the father's immediate vertical neighbour (gap ≈ one
// `row`). A mother who heads her own descent isn't tucked beside the father, so
// the couple can sit far apart in the column; their midpoint would then float in
// empty space, reading as a line from nowhere. Only an adjacent pair has a real
// "between" to sprout from — anything farther falls back to father-origin.
function coLocatedCouples(
  fam: FamilyGraph,
  positions: Positions,
  row: number,
): CoupleGroup[] {
  const sex = fam.sex;
  const parentsOf = fam.trueParentsOf;
  const drawnFathersOf = fam.fatherOf;

  // Resolve each drawn father→child line to its co-located couple, when parentage
  // is unambiguous: exactly one drawn father, exactly one in-view mother, both in
  // the same column. `mid`/`gap` are captured now so the gating below needs no
  // further position lookups.
  type Candidate = {
    father: string;
    mother: string;
    child: string;
    mid: Pos;
    gap: number;
  };
  const candidates: Candidate[] = [];
  // Iterate drawn father→child pairs grouped by child (patrilinealEdges already
  // emits them child-grouped, so this matches the old per-edge order).
  for (const [child, fathers] of drawnFathersOf) {
    if (fathers.length !== 1) continue;
    const father = fathers[0];
    const fp = positions.get(father);
    if (!fp) continue;
    const mothers = (parentsOf.get(child) ?? []).filter(
      (p) => sex.get(p) === "female" && positions.has(p) && p !== father,
    );
    if (mothers.length !== 1) continue;
    const mp = positions.get(mothers[0])!;
    if (Math.round(mp.x) !== Math.round(fp.x)) continue; // not a co-located couple
    candidates.push({
      father,
      mother: mothers[0],
      child,
      mid: { x: fp.x, y: (fp.y + mp.y) / 2 },
      gap: Math.abs(mp.y - fp.y),
    });
  }

  // A father with two or more distinct co-located mothers is polygamous; counted
  // across ALL candidates (before the adjacency gate) so a far second wife still
  // disqualifies. His children draw from the father, not a per-wife midpoint.
  const mothersByFather = new Map<string, Set<string>>();
  for (const c of candidates) addInto(mothersByFather, c.father, c.mother);
  const polygamous = new Set<string>();
  for (const [father, mothers] of mothersByFather) {
    if (mothers.size > 1) polygamous.add(father);
  }

  const byCouple = new Map<string, CoupleGroup>();
  for (const c of candidates) {
    if (polygamous.has(c.father)) continue;
    if (c.gap > row * 1.5) continue; // not an adjacent pair
    const key = `${c.father}|${c.mother}`;
    const group = byCouple.get(key) ?? {
      father: c.father,
      mother: c.mother,
      children: [],
      mid: c.mid,
    };
    group.children.push(c.child);
    byCouple.set(key, group);
  }
  return [...byCouple.values()];
}

// One junction per co-located couple, anchored at their midpoint, replacing the
// drawn father→child edges (hidden by id) with junction→child DESCENT edges.
//
// A lone child that centerOnlyChildren couldn't pull onto the midpoint — a fixed
// blood spouse pinned directly below it aborts the shift (#28) — is left a half row
// off, jogging its descent line. For that one child, drop the junction onto the
// child's row instead (clamped to the parents' marriage segment so it stays between
// them): the line runs straight, sprouting from whichever parent shares that row —
// a smaller artifact than the jog, and no node moves. Only single, near-level
// children qualify: a long-drop child (#27) keeps the midpoint origin, where the
// jog is invisible and the couple-centered start reads right.
export function descentJunctions(
  fam: FamilyGraph,
  positions: Positions,
  row: number,
): DescentJunction[] {
  return coLocatedCouples(fam, positions, row).map((c) => {
    let mid = c.mid;
    if (c.children.length === 1) {
      const cp = positions.get(c.children[0]);
      const fp = positions.get(c.father);
      const mp = positions.get(c.mother);
      if (
        cp &&
        fp &&
        mp &&
        cp.y !== c.mid.y &&
        Math.abs(c.mid.y - cp.y) <= row
      ) {
        const loY = Math.min(fp.y, mp.y);
        const hiY = Math.max(fp.y, mp.y);
        mid = { x: c.mid.x, y: Math.max(loY, Math.min(hiY, cp.y)) };
      }
    }
    return {
      id: `${JUNCTION_PREFIX}|${c.father}|${c.mother}`,
      pos: mid,
      children: c.children,
      hiddenEdgeIds: c.children.map(
        (child) => `${c.father}|PARENT_OF|${child}`,
      ),
    };
  });
}

// Nudge each near-horizontal only-child onto its parents' midpoint so the descent
// line leaves the couple straight instead of jogging half a row. The midpoint
// convention is right; the jog is only the artifact of a lone child sitting on the
// father's row while the mother is packed a row below.
//
// Selection uses the ORIGINAL positions: a single-child couple whose child sits
// within one `row` of the midpoint. A child that drops far below is a long vertical
// line where the half-row is invisible and the midpoint origin already reads right,
// so it's excluded. Selecting on the original layout means a child stays selected
// even after its own parents shift.
//
// Couples are then centered parents-before-children (a father sits one column left
// of his child), and each child is moved onto its parents' LIVE midpoint — after
// the parents may themselves have moved. So an only-child lineage forms a clean
// half-row staircase: every link is straight, the lineage just steps down a half
// row per generation (unavoidable — the midpoint is always half a row below the
// father). The child's tucked-in spouse(s) ride along to keep that couple adjacent,
// and the shift is clamped to the column's row spacing so it never overlaps a
// neighbour. Kept out of `placeNodes` (and thus the #18 parity check): it's a new
// rule, not part of the dagre-placement contract that parity guards.
export function centerOnlyChildren(
  input: Positions,
  fam: FamilyGraph,
  focusId: string,
  row: number,
): Positions {
  const pos = clonePositions(input);
  // Same tuck model packColumns packed the column with: a spouse it tucked beside
  // the child must ride along, or the clamp below would mistake it for a fixed
  // neighbour and pin the shift to 0. Re-deriving movers from spouse edges used
  // to miss the focus's blood-line spouse and transitive co-spouses (#30).
  const attached = tuckHosts(pos, fam, focusId);

  const selected = coLocatedCouples(fam, input, row)
    .filter((c) => {
      if (c.children.length !== 1) return false;
      // coLocatedCouples validates father/mother positions but not the child's, so
      // guard before the deref — same defence the loop and the view already apply.
      const cp = input.get(c.children[0]);
      return cp !== undefined && Math.abs(c.mid.y - cp.y) <= row;
    })
    .sort((a, b) => input.get(a.father)!.x - input.get(b.father)!.x);

  for (const c of selected) {
    const child = c.children[0];
    const cp = pos.get(child);
    const fp = pos.get(c.father);
    const mp = pos.get(c.mother);
    if (!cp || !fp || !mp) continue;
    const dy = (fp.y + mp.y) / 2 - cp.y; // live midpoint: parents may have moved
    if (dy === 0) continue;

    // Move the child together with every spouse tucked beside it (transitively),
    // so the child's own couple keeps its spacing. Walking `attached` from the
    // child reproduces exactly the column block packColumns built around it.
    const col = Math.round(cp.x);
    const movers = tuckChain(attached, child);
    const moverSet = new Set(movers);
    const top = Math.min(...movers.map((m) => pos.get(m)!.y));
    const bottom = Math.max(...movers.map((m) => pos.get(m)!.y));
    // Nearest fixed neighbours above/below the moved block in this column.
    let above = -Infinity;
    let below = Infinity;
    for (const [id, p] of pos) {
      if (moverSet.has(id) || Math.round(p.x) !== col) continue;
      if (p.y < top) above = Math.max(above, p.y);
      if (p.y > bottom) below = Math.min(below, p.y);
    }
    const lo = above === -Infinity ? -Infinity : above + row - top;
    const hi = below === Infinity ? Infinity : below - row - bottom;
    if (lo > hi) continue; // column too tight to center without overlap
    const shift = Math.max(lo, Math.min(hi, dy));
    if (shift === 0) continue;
    for (const m of movers) {
      const p = pos.get(m)!;
      pos.set(m, { x: p.x, y: p.y + shift });
    }
  }
  return pos;
}
