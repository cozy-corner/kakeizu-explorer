import { expect, test } from "bun:test";
import {
  descentJunctions,
  placeNodes,
  project,
  projectOne,
  readPlacement,
  spouseRouting,
  type Positions,
} from "./layout";
import {
  buildFamilyGraph,
  egoDrawnEdges,
  type FamilyGraph,
  type Graph,
  type GraphEdge,
  type PersonId,
  type Sex,
} from "./graph";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROW = 46; // injected; matches the view's NODE_SEP + NODE_SIZE
const GUTTER = 70;

// Fixtures use bare-string ids; brand them at the boundary so the layout's
// PersonId-keyed maps accept them (the real flow brands in readPositions).
const pid = (s: string): PersonId => s as PersonId;

// Compare position Maps as plain objects so a mismatch prints readable diffs.
const obj = (m: Positions) => Object.fromEntries(m);
const pos = (entries: [string, [number, number]][]): Positions =>
  new Map(entries.map(([id, [x, y]]) => [pid(id), { x, y }]));

// The passes now work in {col, order} space. These wrappers keep the assertions in
// pixels: read dagre's pixel input into a placement, run the pass, project back.
const place = (input: Positions, f: FamilyGraph, focus: string): Positions => {
  const { placements, colX } = readPlacement(input, ROW);
  return project(placeNodes(placements, f, pid(focus)), colX, ROW);
};
// Project to plain strings/pixels so assertions read in bare ids, not branded ones.
const junctions = (f: FamilyGraph, input: Positions) => {
  const { placements, colX } = readPlacement(input, ROW);
  return descentJunctions(f, placements).map((j) => ({
    father: j.father as string,
    mother: j.mother as string,
    pos: projectOne(j.pos, colX, ROW),
    children: j.children as string[],
  }));
};

// The passes now take a resolved FamilyGraph. For pack/route cases only the drawn
// edges matter (sex/true-parentage go unused); couple cases also pass the unreduced
// graph so trueParentsOf can recover a dropped mother.
const fam = (drawn: GraphEdge[], g: Graph = { nodes: [], edges: [] }) =>
  buildFamilyGraph(g, drawn);

test("isMarriedIn: a spouse with no parent edge is married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "W", type: "SPOUSE_OF" }];
  expect(fam(edges).isMarriedIn(pid("W"))).toBe(true);
});

test("isMarriedIn: a parent (source of PARENT_OF) is not married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  expect(fam(edges).isMarriedIn(pid("F"))).toBe(false);
});

test("isMarriedIn: a child (target of PARENT_OF) is not married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  expect(fam(edges).isMarriedIn(pid("C"))).toBe(false);
});

test("isMarriedIn: an adopted child is not married-in (adoptive parent places it)", () => {
  const edges: GraphEdge[] = [
    { source: "AP", target: "C", type: "ADOPTIVE_PARENT_OF" },
  ];
  expect(fam(edges).isMarriedIn(pid("C"))).toBe(false);
});

test("placeNodes: a parent centers on its children, packed one row apart", () => {
  // F parents A and B. The tidy layout ignores dagre's row gap and packs the
  // siblings one ROW apart, then centers F on their midpoint — not on dagre's y.
  const edges: GraphEdge[] = [
    { source: "F", target: "A", type: "PARENT_OF" },
    { source: "F", target: "B", type: "PARENT_OF" },
  ];
  const input = pos([
    ["F", [0, 50]],
    ["A", [100, 0]],
    ["B", [100, 100]],
  ]);

  expect(obj(place(input, fam(edges), "F"))).toEqual({
    F: { x: 0, y: 23 },
    A: { x: 100, y: 0 },
    B: { x: 100, y: 46 },
  });
});

test("placeNodes: a married-in spouse joins the host's column, and their child centers on the couple", () => {
  // W married F but dagre left her in her own column (x=200); she has no parent
  // edge, so she tucks one ROW below F in F's column. Their lone child C then
  // sits on the couple's midpoint (half a row below F), so its descent is straight.
  const edges: GraphEdge[] = [
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "W", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
    ["W", [200, 0]],
  ]);

  expect(obj(place(input, fam(edges), "C"))).toEqual({
    F: { x: 0, y: 0 },
    C: { x: 100, y: 23 },
    W: { x: 0, y: 46 },
  });
});

test("placeNodes: a spouse married to two in-tree relatives tucks beside the focus", () => {
  // W married both F1 and F2; with focus=F2, W must host on F2 (not F1).
  const edges: GraphEdge[] = [
    { source: "F1", target: "C1", type: "PARENT_OF" },
    { source: "F2", target: "C2", type: "PARENT_OF" },
    { source: "F1", target: "W", type: "SPOUSE_OF" },
    { source: "F2", target: "W", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F1", [0, 0]],
    ["C1", [100, 0]],
    ["F2", [0, 100]],
    ["C2", [100, 100]],
    ["W", [0, 200]],
  ]);

  // W ends one ROW below F2 (92), proving the focus won the host tie; C2 sits on
  // the F2+W midpoint (69).
  expect(obj(place(input, fam(edges), "F2"))).toEqual({
    F1: { x: 0, y: 0 },
    C1: { x: 100, y: 0 },
    F2: { x: 0, y: 46 },
    C2: { x: 100, y: 69 },
    W: { x: 0, y: 92 },
  });
});

test("placeNodes: the focus's own spouse who heads a blood line is tucked beside the focus", () => {
  // FO and S are spouses, both with their own descent (not married-in), in the
  // same column. The focus-spouse rule tucks S right below FO (46); FO's siblings
  // X, Y then pack below the couple, and PA centers on the FO..Y span.
  const edges: GraphEdge[] = [
    { source: "PA", target: "FO", type: "PARENT_OF" },
    { source: "PA", target: "X", type: "PARENT_OF" },
    { source: "PA", target: "Y", type: "PARENT_OF" },
    { source: "PB", target: "S", type: "PARENT_OF" },
    { source: "FO", target: "S", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["PA", [-100, 50]],
    ["PB", [-100, 300]],
    ["FO", [0, 0]],
    ["X", [0, 100]],
    ["Y", [0, 200]],
    ["S", [0, 300]],
  ]);

  expect(obj(place(input, fam(edges), "FO"))).toEqual({
    PA: { x: -100, y: 69 },
    PB: { x: -100, y: 115 },
    FO: { x: 0, y: 0 },
    S: { x: 0, y: 46 },
    X: { x: 0, y: 92 },
    Y: { x: 0, y: 138 },
  });
});

test("placeNodes: a reverse-direction SPOUSE_OF tucks the focus-spouse once, not twice", () => {
  // The same couple recorded in both directions (P26 is symmetric): without a
  // dedup in the tuck-chain walk, S would be packed twice and land a phantom row
  // lower (y=92 instead of 46).
  const edges: GraphEdge[] = [
    { source: "PA", target: "FO", type: "PARENT_OF" },
    { source: "PB", target: "S", type: "PARENT_OF" },
    { source: "FO", target: "S", type: "SPOUSE_OF" },
    { source: "S", target: "FO", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["PA", [-100, 50]],
    ["PB", [-100, 200]],
    ["FO", [0, 0]],
    ["S", [0, 200]],
  ]);

  expect(obj(place(input, fam(edges), "FO"))).toEqual({
    PA: { x: -100, y: 0 },
    PB: { x: -100, y: 46 },
    FO: { x: 0, y: 0 },
    S: { x: 0, y: 46 },
  });
});

test("placeNodes: an adoptive parent of the focus drops below the sibling cluster", () => {
  // AP enters in the parent column on FO's row (overlapping the blood father PA).
  // It is moved below FO's tidy column cluster (FO=0, sibling X=46), landing at 92,
  // still in the parent column so its arrow keeps pointing right.
  const edges: GraphEdge[] = [
    { source: "PA", target: "FO", type: "PARENT_OF" },
    { source: "PA", target: "X", type: "PARENT_OF" },
    { source: "AP", target: "FO", type: "ADOPTIVE_PARENT_OF" },
  ];
  const input = pos([
    ["PA", [-100, 0]],
    ["FO", [0, 0]],
    ["X", [0, 100]],
    ["AP", [-100, 0]],
  ]);

  expect(obj(place(input, fam(edges), "FO"))).toEqual({
    PA: { x: -100, y: 23 },
    FO: { x: 0, y: 0 },
    X: { x: 0, y: 46 },
    AP: { x: -100, y: 92 },
  });
});

test("placeNodes: multiple adoptive parents are stacked one ROW apart below the cluster", () => {
  // AP1, AP2 both enter on FO's row in the parent column; both drop below FO's tidy
  // column cluster (FO=0, sib=46) and stack in edge order: 92, then 138.
  const edges: GraphEdge[] = [
    { source: "PA", target: "FO", type: "PARENT_OF" },
    { source: "PA", target: "sib", type: "PARENT_OF" },
    { source: "AP1", target: "FO", type: "ADOPTIVE_PARENT_OF" },
    { source: "AP2", target: "FO", type: "ADOPTIVE_PARENT_OF" },
  ];
  const input = pos([
    ["PA", [-100, 0]],
    ["FO", [0, 0]],
    ["sib", [0, 100]],
    ["AP1", [-100, 0]],
    ["AP2", [-100, 0]],
  ]);

  expect(obj(place(input, fam(edges), "FO"))).toEqual({
    PA: { x: -100, y: 23 },
    FO: { x: 0, y: 0 },
    sib: { x: 0, y: 46 },
    AP1: { x: -100, y: 92 },
    AP2: { x: -100, y: 138 },
  });
});

test("placeNodes: an adoptive parent who is also a blood parent is left in place", () => {
  // N parents FO both by blood and adoption; the blood line owns the column, so
  // the adoptive-parent relocation must skip N.
  const edges: GraphEdge[] = [
    { source: "N", target: "FO", type: "PARENT_OF" },
    { source: "N", target: "FO", type: "ADOPTIVE_PARENT_OF" },
  ];
  const input = pos([
    ["N", [-100, 0]],
    ["FO", [0, 0]],
  ]);

  expect(obj(place(input, fam(edges), "FO"))).toEqual({
    N: { x: -100, y: 0 },
    FO: { x: 0, y: 0 },
  });
});

test("placeNodes: a disputed child's second father still gets a placement, not a stale row", () => {
  // C has two drawn fathers (disputed parentage); the layout files C under the
  // first (F1) and treats F2 as a cross-link. F2 must still be re-solved into the
  // shared order frame — here below F1 in the same column — not left at its raw
  // dagre row where it could overlap a tidy-placed node.
  const edges: GraphEdge[] = [
    { source: "F1", target: "C", type: "PARENT_OF" },
    { source: "F2", target: "C", type: "PARENT_OF" },
  ];
  const input = pos([
    ["F1", [0, 0]],
    ["F2", [0, 46]],
    ["C", [100, 0]],
  ]);

  expect(obj(place(input, fam(edges), "C"))).toEqual({
    F1: { x: 0, y: 0 },
    F2: { x: 0, y: 46 },
    C: { x: 100, y: 0 },
  });
});

test("placeNodes: a malformed ancestry cycle terminates and still places every node", () => {
  // Bad data can record a parent loop (R→A→B→A). The recursion must not spin
  // forever; the cycle guard bails on the second visit, and every node still lands.
  const edges: GraphEdge[] = [
    { source: "R", target: "A", type: "PARENT_OF" },
    { source: "A", target: "B", type: "PARENT_OF" },
    { source: "B", target: "A", type: "PARENT_OF" },
  ];
  const input = pos([
    ["R", [0, 0]],
    ["A", [100, 0]],
    ["B", [200, 0]],
  ]);

  expect(obj(place(input, fam(edges), "R"))).toEqual({
    R: { x: 0, y: 0 },
    A: { x: 100, y: 0 },
    B: { x: 200, y: 0 },
  });
});

test("spouseRouting: a clear marriage line is not routed", () => {
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 0]],
    ["T", [0, 46]],
  ]);

  expect(spouseRouting(input, fam(edges), GUTTER)).toEqual([]);
});

test("spouseRouting: a line blocked by an unrelated node is bowed", () => {
  // U sits on the midline between S and T and is no co-spouse, so the line detours.
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 0]],
    ["T", [0, 200]],
    ["U", [0, 100]],
  ]);

  expect(spouseRouting(input, fam(edges), GUTTER)).toEqual([
    { source: pid("S"), target: pid("T"), bow: 70 },
  ]);
});

test("spouseRouting: a co-spouse between the partners does not block", () => {
  // CS is another spouse of S, so passing among co-spouses is allowed.
  const edges: GraphEdge[] = [
    { source: "S", target: "T", type: "SPOUSE_OF" },
    { source: "S", target: "CS", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["S", [0, 0]],
    ["T", [0, 200]],
    ["CS", [0, 100]],
  ]);

  expect(spouseRouting(input, fam(edges), GUTTER)).toEqual([]);
});

test("spouseRouting: the bow sign follows the source→target vertical direction", () => {
  // Source below target: the bow flips negative.
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 200]],
    ["T", [0, 0]],
    ["U", [0, 100]],
  ]);

  expect(spouseRouting(input, fam(edges), GUTTER)).toEqual([
    { source: pid("S"), target: pid("T"), bow: -70 },
  ]);
});

test("placeNodes: an empty graph yields an empty map", () => {
  expect(obj(place(new Map(), fam([]), "anyone"))).toEqual({});
});

test("placeNodes: a focus absent from the positions still places everyone else", () => {
  // No focus node present: the focus-spouse and adoptive passes are skipped (they
  // early-return), but a married-in spouse still tucks beside its host.
  const edges: GraphEdge[] = [
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "W", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
    ["W", [200, 0]],
  ]);

  expect(obj(place(input, fam(edges), "MISSING"))).toEqual({
    F: { x: 0, y: 0 },
    C: { x: 100, y: 23 },
    W: { x: 0, y: 46 },
  });
});

test("spouseRouting: a graph with no marriage edges routes nothing", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const input = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
  ]);

  expect(spouseRouting(input, fam(edges), GUTTER)).toEqual([]);
});

test("spouseRouting: an empty graph routes nothing", () => {
  expect(spouseRouting(new Map(), fam([]), GUTTER)).toEqual([]);
});

test("projectOne: a col absent from colX throws instead of emitting an undefined x", () => {
  // Boundary contract: every Placement.col is seeded by readPlacement, so it's
  // always a colX key. A col that isn't is a column-bookkeeping bug — fail loud
  // here rather than projecting the bucket index as a far-left ghost pixel.
  expect(() =>
    projectOne({ col: 5, order: 2 }, new Map([[0, 0]]), ROW),
  ).toThrow();
});

const graph = (
  nodes: [string, Sex | undefined][],
  edges: GraphEdge[],
): Graph => ({
  nodes: nodes.map(([qid, sex]) => ({ qid, label: qid, sex })),
  edges,
});

test("descentJunctions: a father+mother couple yields a midpoint junction over their child", () => {
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["C", undefined],
    ],
    [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
    ],
  );
  // Drawn (patrilineal) edges keep only father→child; the mother is recovered
  // from the unreduced graph above.
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  // C already sits on the midpoint (the tidy pass centers it there in the real
  // flow), so the junction stays at the couple's midpoint.
  const positions = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["C", [100, 23]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([
    {
      father: "F",
      mother: "M",
      pos: { x: 0, y: 23 },
      children: ["C"],
    },
  ]);
});

test("descentJunctions: two children of one couple share a single junction", () => {
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["C1", undefined],
      ["C2", undefined],
    ],
    [
      { source: "F", target: "C1", type: "PARENT_OF" },
      { source: "M", target: "C1", type: "PARENT_OF" },
      { source: "F", target: "C2", type: "PARENT_OF" },
      { source: "M", target: "C2", type: "PARENT_OF" },
    ],
  );
  const drawn: GraphEdge[] = [
    { source: "F", target: "C1", type: "PARENT_OF" },
    { source: "F", target: "C2", type: "PARENT_OF" },
  ];
  const positions = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["C1", [100, 0]],
    ["C2", [100, 100]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([
    {
      father: "F",
      mother: "M",
      pos: { x: 0, y: 23 },
      children: ["C1", "C2"],
    },
  ]);
});

test("descentJunctions: no in-view mother yields no junction (line stays on the father)", () => {
  const g = graph(
    [
      ["F", "male"],
      ["C", undefined],
    ],
    [{ source: "F", target: "C", type: "PARENT_OF" }],
  );
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const positions = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("descentJunctions: a child with two drawn fathers (disputed) gets no junction", () => {
  const g = graph(
    [
      ["F1", undefined],
      ["F2", undefined],
      ["M", "female"],
      ["C", undefined],
    ],
    [
      { source: "F1", target: "C", type: "PARENT_OF" },
      { source: "F2", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
    ],
  );
  // Both unknown-sex fathers survive the patrilineal reduction.
  const drawn: GraphEdge[] = [
    { source: "F1", target: "C", type: "PARENT_OF" },
    { source: "F2", target: "C", type: "PARENT_OF" },
  ];
  const positions = pos([
    ["F1", [0, 0]],
    ["F2", [0, 46]],
    ["M", [0, 92]],
    ["C", [100, 0]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("descentJunctions: a polygamous father's children fall back to father-origin (no junction)", () => {
  // F has children by two different in-view mothers. A per-wife midpoint among
  // stacked wives no longer reads as "which mother", so traditional patrilineal
  // drawing wins: every child line stays on the father.
  const g = graph(
    [
      ["F", "male"],
      ["M1", "female"],
      ["M2", "female"],
      ["C1", undefined],
      ["C2", undefined],
    ],
    [
      { source: "F", target: "C1", type: "PARENT_OF" },
      { source: "M1", target: "C1", type: "PARENT_OF" },
      { source: "F", target: "C2", type: "PARENT_OF" },
      { source: "M2", target: "C2", type: "PARENT_OF" },
    ],
  );
  const drawn: GraphEdge[] = [
    { source: "F", target: "C1", type: "PARENT_OF" },
    { source: "F", target: "C2", type: "PARENT_OF" },
  ];
  const positions = pos([
    ["F", [0, 0]],
    ["M1", [0, 46]],
    ["M2", [0, 92]],
    ["C1", [100, 0]],
    ["C2", [100, 100]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("descentJunctions: a wife with no in-view children doesn't make the father polygamous", () => {
  // F has two wives present, but only M1 mothers an in-view child; M2 (childless
  // here) must not suppress M1's midpoint.
  const g = graph(
    [
      ["F", "male"],
      ["M1", "female"],
      ["M2", "female"],
      ["C", undefined],
    ],
    [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M1", target: "C", type: "PARENT_OF" },
    ],
  );
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  // C on the midpoint (the centered real-flow state); the junction stays there.
  const positions = pos([
    ["F", [0, 0]],
    ["M1", [0, 46]],
    ["M2", [0, 92]],
    ["C", [100, 23]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([
    {
      father: "F",
      mother: "M1",
      pos: { x: 0, y: 23 },
      children: ["C"],
    },
  ]);
});

test("descentJunctions: a lone female parent (drawn as the father) gets no junction", () => {
  // No male parent, so the patrilineal view draws the mother herself as the
  // descent source. She must not be paired with herself into a degenerate junction.
  const g = graph(
    [
      ["M", "female"],
      ["C", undefined],
    ],
    [{ source: "M", target: "C", type: "PARENT_OF" }],
  );
  const drawn: GraphEdge[] = [{ source: "M", target: "C", type: "PARENT_OF" }];
  const positions = pos([
    ["M", [0, 0]],
    ["C", [100, 0]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("descentJunctions: a couple too far apart vertically gets no junction", () => {
  // M heads her own descent, so she isn't tucked beside F — they sit rows apart
  // in the column. Their midpoint would float in empty space, so fall back to F.
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["C", undefined],
    ],
    [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
    ],
  );
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const positions = pos([
    ["F", [0, 0]],
    ["M", [0, 300]], // far below F, not an adjacent pair
    ["C", [100, 0]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("descentJunctions: parents in different columns are not treated as a couple", () => {
  // A cross-generation parentage: the mother sits in another column, so no
  // vertical midpoint applies — keep the father's line.
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["C", undefined],
    ],
    [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
    ],
  );
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const positions = pos([
    ["F", [0, 0]],
    ["M", [200, 0]],
    ["C", [100, 0]],
  ]);

  expect(junctions(fam(drawn, g), positions)).toEqual([]);
});

test("placeNodes: the focus's blood-line spouse rides along, keeping their child centered", () => {
  // Couple F+M's only child is the focus FO. FO's spouse S heads her own blood
  // line (not married-in), yet the focus-spouse rule tucks her into FO's couple
  // block, so FO stays centered on the F+M midpoint (23) and S rides one ROW below
  // it (69). S's own father PS is a cross-link, rooting its own (childless) subtree.
  const drawn: GraphEdge[] = [
    { source: "F", target: "FO", type: "PARENT_OF" },
    { source: "F", target: "M", type: "SPOUSE_OF" },
    { source: "PS", target: "S", type: "PARENT_OF" },
    { source: "FO", target: "S", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["FO", [100, 0]],
    ["S", [100, 46]],
    ["PS", [200, 0]],
  ]);

  expect(obj(place(input, fam(drawn), "FO"))).toEqual({
    F: { x: 0, y: 0 },
    M: { x: 0, y: 46 },
    FO: { x: 100, y: 23 },
    S: { x: 100, y: 69 },
    PS: { x: 200, y: 23 },
  });
});

test("placeNodes: a transitive co-spouse below the focus's spouse rides along", () => {
  // As above, but S in turn has a married-in co-spouse T. T is two hops from FO
  // (FO→S→T); the tuck-chain walk still pulls her into FO's couple block, so the
  // whole block rides together and FO stays on the F+M midpoint.
  const drawn: GraphEdge[] = [
    { source: "F", target: "FO", type: "PARENT_OF" },
    { source: "F", target: "M", type: "SPOUSE_OF" },
    { source: "PS", target: "S", type: "PARENT_OF" },
    { source: "FO", target: "S", type: "SPOUSE_OF" },
    { source: "S", target: "T", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["FO", [100, 0]],
    ["S", [100, 46]],
    ["T", [100, 92]],
    ["PS", [200, 0]],
  ]);

  expect(obj(place(input, fam(drawn), "FO"))).toEqual({
    F: { x: 0, y: 0 },
    M: { x: 0, y: 46 },
    FO: { x: 100, y: 23 },
    S: { x: 100, y: 69 },
    T: { x: 100, y: 115 },
    PS: { x: 200, y: 23 },
  });
});

// ---------- golden fixtures: full pipeline on frozen dagre output ----------
// lib/layout is pure over dagre's coordinates, so freezing that output (regenerated
// by scripts/gen-layout-fixtures.ts) pins the pipeline without the live DB. `expected`
// is a snapshot, not an oracle — eyeball it when regenerating.
type Fixture = {
  qid: string;
  label: string;
  graph: Graph;
  dagre: Record<string, [number, number]>;
  expected: {
    positions: Record<string, [number, number]>;
    routing: { source: PersonId; target: PersonId; bow: number }[];
  };
};

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "layout");
const asPixels = (m: Positions): Record<string, [number, number]> =>
  Object.fromEntries([...m].map(([id, { x, y }]) => [id, [x, y]]));

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) =>
  f.endsWith(".json"),
);
// Guard the dynamic loop: a lost/empty fixture dir would otherwise register zero
// tests and pass green, silently deleting this whole regression guard.
test("layout golden: fixtures are present", () => {
  expect(fixtureFiles.length).toBeGreaterThan(0);
});

for (const file of fixtureFiles) {
  const fx: Fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
  test(`layout golden: ${fx.label} (${fx.qid})`, () => {
    const dagre = pos(Object.entries(fx.dagre));
    const family = buildFamilyGraph(fx.graph, egoDrawnEdges(fx.graph));
    const placed = place(dagre, family, fx.qid);
    expect(asPixels(placed)).toEqual(fx.expected.positions);
    expect(spouseRouting(placed, family, GUTTER)).toEqual(fx.expected.routing);
  });
}
