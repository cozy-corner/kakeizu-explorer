import { pushInto, type FamilyGraph, type PersonId } from "./graph";

// Plain-data view of cytoscape's "graph + coordinates": placement rules operate
// on these instead of touching the renderer, so they're unit-testable. The view
// reads dagre's output into a Positions map, runs these, and writes back. Keyed by
// PersonId: every node placed here is a real person, never a junction.
export type Pos = { x: number; y: number };
export type Positions = Map<PersonId, Pos>; // insertion order mirrors cy.nodes()

// Structural coordinate the placement passes actually work in. `col` is the
// generation column (dagre's rank, keyed by round(x) — uniform within a rank);
// `order` is the row index y/row, a real number so dagre's gaps, a tucked spouse
// (+1) and a couple midpoint (x.5) are all expressed without pixel arithmetic.
// readPlacement projects pixels in; project sends them back out. Keeping the rules
// in this space drops `row` from every pass and centralises the round(x).
export type Placement = { col: number; order: number };
export type Placements = Map<PersonId, Placement>;

// Pixel → structural at the layout boundary. round(x) happens here, once, and the
// per-column actual x is captured in colX so project reproduces dagre's column
// positions exactly rather than assuming a uniform stride — dagre's per-rank x is
// not guaranteed to be a fixed multiple.
export function readPlacement(
  pos: Positions,
  row: number,
): { placements: Placements; colX: Map<number, number> } {
  const placements: Placements = new Map();
  const colX = new Map<number, number>();
  for (const [id, p] of pos) {
    const col = Math.round(p.x);
    if (!colX.has(col)) colX.set(col, p.x); // x is uniform within a column
    placements.set(id, { col, order: p.y / row });
  }
  return { placements, colX };
}

// Structural → pixel: x from the column's captured value, y back to order×row.
// Every col a pass emits is copied from a placement readPlacement seeded, so it's
// always a colX key. Throw on a miss rather than emitting an x: a TS `!` is erased
// at runtime and would yield x: undefined; falling back to pl.col would project the
// bucket index as a pixel — both hide a column-bookkeeping bug as a far-left ghost.
export function projectOne(
  pl: Placement,
  colX: Map<number, number>,
  row: number,
): Pos {
  const x = colX.get(pl.col);
  if (x === undefined) {
    throw new Error(`projectOne: column ${pl.col} not present in colX`);
  }
  return { x, y: pl.order * row };
}

export function project(
  placements: Placements,
  colX: Map<number, number>,
  row: number,
): Positions {
  const pos: Positions = new Map();
  for (const [id, pl] of placements) pos.set(id, projectOne(pl, colX, row));
  return pos;
}

function addInto<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
}

function clonePlacements(p: Placements): Placements {
  return new Map(
    [...p].map(([id, pl]) => [id, { col: pl.col, order: pl.order }]),
  );
}

// Resolve who tucks beside whom, as host → its directly-attached spouse ids:
// a married-in spouse rides beside the in-tree partner it married (preferring the
// focus when it married more than one in-tree relative), and the focus's own
// spouse rides beside the focus even when that spouse heads their own blood line.
// Transitive co-spouses are reached by walking the map (a tucked spouse may host
// its own). Depends only on edges, the present node set, and the focus column —
// not on order — so it's stable however the tidy layout stacks the column.
function tuckHosts(
  place: Placements,
  fam: FamilyGraph,
  focusId: PersonId,
): Map<PersonId, PersonId[]> {
  const hostOf = (id: PersonId): PersonId | null => {
    const anchors = (fam.spouseOf.get(id) ?? []).filter(
      (p) => p !== id && place.has(p) && !fam.isMarriedIn(p),
    );
    if (anchors.length === 0) return null;
    return anchors.find((p) => p === focusId) ?? anchors[0];
  };

  const attached = new Map<PersonId, PersonId[]>();
  for (const [id] of place) {
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
  const focus = place.get(focusId);
  if (focus && !fam.isMarriedIn(focusId)) {
    for (const sp of fam.spouseOf.get(focusId) ?? []) {
      if (sp === focusId || fam.isMarriedIn(sp)) continue;
      const spp = place.get(sp);
      if (!spp || spp.col !== focus.col) continue;
      pushInto(attached, focusId, sp);
    }
  }
  return attached;
}

// Flatten a host's tuck chain in DFS pre-order, host first: a tucked-in spouse
// may itself host co-spouses, so this walks the whole `attached` subtree.
function tuckChain(
  attached: Map<PersonId, PersonId[]>,
  root: PersonId,
): PersonId[] {
  const chain: PersonId[] = [];
  const seen = new Set<PersonId>(); // a reverse-direction SPOUSE_OF can list a
  // partner twice; visit each once so the couple block doesn't gain a phantom row
  const walk = (id: PersonId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    for (const a of attached.get(id) ?? []) walk(a);
  };
  walk(root);
  return chain;
}

// A laid-out subtree in relative order units: `row` is the blood node's own row,
// `order` the rows of every person under it, and top/bottom the per-column extent
// of occupied rows (the contour the sibling packing clears).
type Subtree = {
  row: number;
  order: Map<PersonId, number>;
  top: Map<number, number>;
  bottom: Map<number, number>;
};

// Stack sibling subtrees top-to-bottom, each shifted just enough to clear the
// running contour of the ones above by one row in every shared column. Direct
// siblings always share their own column (children of one parent sit one column
// right of it), so that column pins the ordering; deeper generations extend the
// contour rightward and keep cousin subtrees from overlapping. Returns each
// subtree's shifted node row plus the merged order map and contour.
function stackSubtrees(subs: Subtree[]): {
  rows: number[];
  order: Map<PersonId, number>;
  top: Map<number, number>;
  bottom: Map<number, number>;
} {
  const order = new Map<PersonId, number>();
  const top = new Map<number, number>();
  const bottom = new Map<number, number>();
  const rows: number[] = [];
  for (const sub of subs) {
    // Clear the running contour by one row in every shared column; an unshared
    // column contributes -Infinity so it never binds, and the 0 floor keeps a
    // subtree from sliding up.
    const shift = Math.max(
      0,
      ...[...sub.top].map(([col, t]) => {
        const b = bottom.get(col);
        return b === undefined ? -Infinity : b + 1 - t;
      }),
    );
    for (const [id, o] of sub.order) order.set(id, o + shift);
    for (const [col, t] of sub.top)
      top.set(col, Math.min(top.get(col) ?? Infinity, t + shift));
    for (const [col, b] of sub.bottom)
      bottom.set(col, Math.max(bottom.get(col) ?? -Infinity, b + shift));
    rows.push(sub.row + shift);
  }
  return { rows, order, top, bottom };
}

// Recompute vertical order as a Reingold–Tilford tidy layout of the descent
// forest, keeping dagre's generation column (`col`) as the fixed depth axis and
// solving only `order`. A couple (a blood node plus the spouses tucked below it)
// is one block; a parent's descent junction centers on the span of its children's
// rows, so the parent's own row sits half a block above that — giving symmetric
// fans, straight lone-child lines, and centered parents by construction. dagre's
// barycenter y lacks those invariants, so its descent lines can fold
// asymmetrically; the tidy layout removes that whole class rather than patching it.
function orderDescentForest(
  input: Placements,
  fam: FamilyGraph,
  focusId: PersonId,
): Placements {
  const place = clonePlacements(input);
  const attached = tuckHosts(place, fam, focusId);
  const tucked = new Set<PersonId>([...attached.values()].flat());

  // child → the one parent that owns its tree position; the first present parent
  // (blood before adoptive) wins, any others are cross-links the layout ignores. A
  // tucked spouse isn't placed as its own blood parent's child — the couple it
  // rides in owns its row, so that ancestor edge stays a cross-link.
  const inputOrder = new Map(
    [...place.keys()].map((id, i) => [id, i] as const),
  );
  const childrenOf = new Map<PersonId, PersonId[]>();
  const placedAsChild = new Set<PersonId>();
  for (const child of place.keys()) {
    if (tucked.has(child)) continue;
    const blood = (fam.fatherOf.get(child) ?? []).filter((p) => place.has(p));
    const parents = blood.length
      ? blood
      : (fam.adoptiveParentOf.get(child) ?? []).filter((p) => place.has(p));
    if (parents.length === 0) continue;
    placedAsChild.add(child);
    pushInto(childrenOf, parents[0], child);
  }

  const coupleCol = new Map<PersonId, number>();
  const laidOut = new Set<PersonId>();
  const layout = (node: PersonId): Subtree => {
    // Guard against a malformed ancestry cycle in the drawn edges (Wikidata can
    // record a person as their own ancestor): revisiting a node would recurse
    // forever. A node is legitimately laid out once, so a repeat means a cycle.
    if (laidOut.has(node))
      return { row: 0, order: new Map(), top: new Map(), bottom: new Map() };
    laidOut.add(node);
    const col = place.get(node)!.col;
    const couple = tuckChain(attached, node); // [node, ...tucked spouses]
    const spouses = couple.slice(1);
    const k = spouses.length;
    // A couple's children hang from ALL its members: a spouse who married in but
    // heads their own line (drawn as the father of the couple's child) contributes
    // that child, so the whole couple centers on it instead of the spouse drifting
    // off to head a separate subtree. Merge across members back into reading order.
    const kids = couple
      .flatMap((m) => childrenOf.get(m) ?? [])
      .sort((a, b) => inputOrder.get(a)! - inputOrder.get(b)!);

    const stacked = kids.length
      ? stackSubtrees(kids.map(layout))
      : {
          rows: [] as number[],
          order: new Map<PersonId, number>(),
          top: new Map<number, number>(),
          bottom: new Map<number, number>(),
        };
    const { order, top, bottom } = stacked;
    // Father sits half a block above the junction — the center of the children's
    // rows; a childless couple has no junction, so its block starts at row 0.
    const row = kids.length
      ? (Math.min(...stacked.rows) + Math.max(...stacked.rows)) / 2 - k / 2
      : 0;

    order.set(node, row);
    spouses.forEach((s, idx) => {
      order.set(s, row + 1 + idx);
      coupleCol.set(s, col); // a tucked spouse joins its host's column
    });
    // The node's own column sits one generation left of every child, so it's never
    // already in the child-derived contour — set it outright.
    top.set(col, row);
    bottom.set(col, row + k);
    return { row, order, top, bottom };
  };

  // Every node that isn't someone's tree-child and isn't a tucked spouse roots its
  // own subtree — including a childless loner, an off-host married-in spouse, or a
  // disputed second father whose child the layout filed under the first. Rooting
  // them all keeps the whole graph in one normalized order frame, so nothing is
  // left stranded at a stale dagre row where it could overlap a tidy-placed node.
  const ordered = [...place.keys()].sort(
    (a, b) => inputOrder.get(a)! - inputOrder.get(b)!,
  );
  const rootSubs = ordered
    .filter((n) => !tucked.has(n) && !placedAsChild.has(n))
    .map(layout);
  // A closed ancestry cycle (every member is placedAsChild, so none is a root)
  // is unreached by the pass above; lay out each still-unplaced node as its own
  // root so it too lands in the normalized frame instead of keeping stale dagre
  // coordinates. `laidOut` skips cycle members already covered by an earlier entry.
  const cycleSubs = ordered
    .filter((n) => !tucked.has(n) && !laidOut.has(n))
    .map(layout);
  const placed = stackSubtrees([...rootSubs, ...cycleSubs]);
  const rows = [...placed.order.values()];
  const offset = rows.length ? -Math.min(...rows) : 0;
  for (const [id, o] of placed.order)
    place.set(id, {
      col: coupleCol.get(id) ?? place.get(id)!.col,
      order: o + offset,
    });
  return place;
}

// Pull a floating spouse-only component back beside its partner. A person who heads
// their own descent line (isMarriedIn=false, so tuckHosts skips them) yet reaches the
// focus tree only through a marriage lands in dagre's leftmost rank, drawing a marriage
// line across generations. When such a component can slide to its partner's column
// WITHOUT breaking another of its marriages, do so — its subtree and tucked spouses
// ride along rigidly, so every internal parent/child column gap is preserved.
//
// The moving unit is the drawn descent forest (father/adoptive edges) UNIONED with
// tuck links (a married-in spouse joins its host), so a spouse riding in a component
// moves with it. A SPOUSE_OF edge crossing two components is an external bridge; its
// col-delta is how far the component must slide to co-column that couple. A component
// slides only when all its external bridges agree on one non-zero delta (an unambiguous
// target) and every shifted member lands on an existing column. Disagreeing deltas mean
// the marriage is genuinely cross-generation (崇源院×秀勝 vs 千姫×秀頼 — mother and
// daughter marrying into the same column can't both co-column) so the line is left honest.
function pullFloatingComponents(
  input: Placements,
  fam: FamilyGraph,
  focusId: PersonId,
  colX: Map<number, number>,
): Placements {
  const place = clonePlacements(input);
  if (!place.has(focusId)) return place; // no anchor tree to pull toward

  const attached = tuckHosts(place, fam, focusId);

  const parent = new Map<PersonId, PersonId>();
  for (const id of place.keys()) parent.set(id, id);
  const find = (x: PersonId): PersonId => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: PersonId, b: PersonId): void => {
    parent.set(find(a), find(b));
  };
  const linkParents = (m: Map<PersonId, PersonId[]>): void => {
    for (const [child, parents] of m)
      for (const p of parents) if (place.has(p)) union(child, p);
  };
  linkParents(fam.fatherOf);
  linkParents(fam.adoptiveParentOf);
  for (const [host, spouses] of attached)
    for (const s of spouses) union(s, host);

  // The focus's component is the anchor tree and never moves.
  const focusRoot = find(focusId);
  const members = new Map<PersonId, PersonId[]>();
  for (const id of place.keys()) pushInto(members, find(id), id);

  for (const [root, ids] of members) {
    if (root === focusRoot) continue;
    // Slide distance implied by each external bridge = target partner's column minus
    // the member's; a spouse inside the same component rides along, so it's no constraint.
    const deltas = new Set<number>();
    for (const id of ids)
      for (const sp of fam.spouseOf.get(id) ?? []) {
        if (!place.has(sp) || find(sp) === root) continue;
        deltas.add(place.get(sp)!.col - place.get(id)!.col);
      }
    if (deltas.size !== 1) continue; // no bridge, or conflicting targets
    const delta = [...deltas][0];
    if (delta === 0) continue; // already co-columned
    if (!ids.every((id) => colX.has(place.get(id)!.col + delta))) continue; // off-grid
    for (const id of ids) {
      const pl = place.get(id)!;
      place.set(id, { col: pl.col + delta, order: pl.order });
    }
  }
  return place;
}

// An adoptive parent of the focus enters dagre via its ADOPTIVE_PARENT_OF edge,
// so it lands in the blood-parent column on the focus's own row — right on top of
// the real father. Drop each below the focus's sibling cluster: still left of the
// focus (parent side, arrow still points right), but clear of the blood-parent
// line. Skip anyone who is ALSO a blood parent of the focus — their line owns that
// column, and moving them would tear the blood tree. (A node that merely parents
// some other in-view person by succession is still moved.)
function placeAdoptiveParents(
  input: Placements,
  fam: FamilyGraph,
  focusId: PersonId,
): Placements {
  const place = clonePlacements(input);
  const focus = place.get(focusId);
  if (!focus) return place;
  const bloodParents = new Set(fam.fatherOf.get(focusId) ?? []);
  const seen = new Set<PersonId>();
  const parents = (fam.adoptiveParentOf.get(focusId) ?? []).filter((p) => {
    if (bloodParents.has(p) || !place.has(p) || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  if (parents.length === 0) return place;

  // The sibling cluster is everyone the tidy pass placed in the focus's column.
  let clusterBottom = -Infinity;
  for (const p of place.values()) {
    if (p.col === focus.col) clusterBottom = Math.max(clusterBottom, p.order);
  }
  let order = clusterBottom + 1;
  for (const id of parents) {
    place.set(id, { col: place.get(id)!.col, order });
    order += 1;
  }
  return place;
}

// Each stage clones its input and returns a new map, so neither mutates the
// caller's placements; the view writes the projected result back into cytoscape.
export function placeNodes(
  place: Placements,
  fam: FamilyGraph,
  focusId: PersonId,
  colX: Map<number, number>,
): Placements {
  return placeAdoptiveParents(
    orderDescentForest(
      pullFloatingComponents(place, fam, focusId, colX),
      fam,
      focusId,
    ),
    fam,
    focusId,
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
//
// Runs on projected pixels (post-project), not placements: the block test is a
// pixel proximity check (BLOCK_X_RADIUS in px, the mid-x between two columns), so
// it stays in pixel space and needs no row.
//
// Returns the couple (source, target) and the bow, not a cytoscape edge id: building
// the `source|SPOUSE_OF|target` address is the view's job, so lib/layout never holds
// a concatenated key.
export function spouseRouting(
  pos: Positions,
  fam: FamilyGraph,
  spouseGutter: number,
): { source: PersonId; target: PersonId; bow: number }[] {
  const nodes = [...pos.entries()];
  return fam.spousePairs.flatMap((edge) => {
    const sp = pos.get(edge.source);
    const tp = pos.get(edge.target);
    if (!sp || !tp) return [];
    const [yLo, yHi] = sp.y < tp.y ? [sp.y, tp.y] : [tp.y, sp.y];
    const x = (sp.x + tp.x) / 2;
    const coSpouses = new Set<PersonId>([
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
    return [{ source: edge.source, target: edge.target, bow }];
  });
}

// An invisible anchor placed at the midpoint of a couple so the descent line
// sprouts from between the parents (the genealogy T-join) instead of from the
// father alone. The view projects `pos` to pixels, adds a node there, draws
// junction→child edges, and hides the original father→child edges. The cytoscape
// ids (the junction's own JunctionId, the hidden `father|PARENT_OF|child` keys) are
// the view's to build from these fields — lib/layout stays free of concat keys.
export type DescentJunction = {
  father: PersonId;
  mother: PersonId;
  pos: Placement;
  children: PersonId[]; // child ids to connect from the junction
};

// A co-located couple and the drawn children that hang from their midpoint. The
// shared resolution behind both the rendered junction and the only-child centering
// nudge, so the two always agree on which couples qualify.
type CoupleGroup = {
  father: PersonId;
  mother: PersonId;
  children: PersonId[];
  mid: Placement;
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
// The mother must also be the father's immediate vertical neighbour (order gap ≈
// one row). A mother who heads her own descent isn't tucked beside the father, so
// the couple can sit far apart in the column; their midpoint would then float in
// empty space, reading as a line from nowhere. Only an adjacent pair has a real
// "between" to sprout from — anything farther falls back to father-origin.
function coLocatedCouples(
  fam: FamilyGraph,
  placements: Placements,
): CoupleGroup[] {
  const sex = fam.sex;
  const parentsOf = fam.trueParentsOf;
  const drawnFathersOf = fam.fatherOf;

  // Resolve each drawn father→child line to its co-located couple, when parentage
  // is unambiguous: exactly one drawn father, exactly one in-view mother, both in
  // the same column. `mid`/`gap` are captured now so the gating below needs no
  // further placement lookups.
  type Candidate = {
    father: PersonId;
    mother: PersonId;
    child: PersonId;
    mid: Placement;
    gap: number;
  };
  const candidates: Candidate[] = [];
  // Iterate drawn father→child pairs grouped by child (patrilinealEdges already
  // emits them child-grouped, so this matches the old per-edge order).
  for (const [child, fathers] of drawnFathersOf) {
    if (fathers.length !== 1) continue;
    const father = fathers[0];
    const fp = placements.get(father);
    if (!fp) continue;
    const mothers = (parentsOf.get(child) ?? []).filter(
      (p) => sex.get(p) === "female" && placements.has(p) && p !== father,
    );
    if (mothers.length !== 1) continue;
    const mp = placements.get(mothers[0])!;
    if (mp.col !== fp.col) continue; // not a co-located couple
    candidates.push({
      father,
      mother: mothers[0],
      child,
      mid: { col: fp.col, order: (fp.order + mp.order) / 2 },
      gap: Math.abs(mp.order - fp.order),
    });
  }

  // A father with two or more distinct co-located mothers is polygamous; counted
  // across ALL candidates (before the adjacency gate) so a far second wife still
  // disqualifies. His children draw from the father, not a per-wife midpoint.
  const mothersByFather = new Map<PersonId, Set<PersonId>>();
  for (const c of candidates) addInto(mothersByFather, c.father, c.mother);
  const polygamous = new Set<PersonId>();
  for (const [father, mothers] of mothersByFather) {
    if (mothers.size > 1) polygamous.add(father);
  }

  const byCouple = new Map<string, CoupleGroup>();
  for (const c of candidates) {
    if (polygamous.has(c.father)) continue;
    if (c.gap > 1.5) continue; // not an adjacent pair
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
// drawn father→child edges (hidden by id) with junction→child DESCENT edges. The
// tidy layout centers each couple's junction on its children's rows, so a lone
// child's line already runs straight from the midpoint — no jog to special-case.
export function descentJunctions(
  fam: FamilyGraph,
  placements: Placements,
): DescentJunction[] {
  return coLocatedCouples(fam, placements).map((c) => ({
    father: c.father,
    mother: c.mother,
    pos: c.mid,
    children: c.children,
  }));
}
