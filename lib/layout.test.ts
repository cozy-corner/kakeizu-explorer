import { expect, test } from "bun:test";
import {
  centerOnlyChildren,
  descentJunctions,
  isMarriedIn,
  placeNodes,
  spouseRouting,
} from "./layout";
import type { Graph, GraphEdge } from "./graph";

const ROW = 46; // injected; matches the view's NODE_SEP + NODE_SIZE
const GUTTER = 70;

// Compare position Maps as plain objects so a mismatch prints readable diffs.
const obj = (m: Map<string, { x: number; y: number }>) => Object.fromEntries(m);
const pos = (entries: [string, [number, number]][]) =>
  new Map(entries.map(([id, [x, y]]) => [id, { x, y }]));

test("isMarriedIn: a spouse with no parent edge is married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "W", type: "SPOUSE_OF" }];
  expect(isMarriedIn("W", edges)).toBe(true);
});

test("isMarriedIn: a parent (source of PARENT_OF) is not married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  expect(isMarriedIn("F", edges)).toBe(false);
});

test("isMarriedIn: a child (target of PARENT_OF) is not married-in", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  expect(isMarriedIn("C", edges)).toBe(false);
});

test("isMarriedIn: an adopted child is not married-in (adoptive parent places it)", () => {
  const edges: GraphEdge[] = [
    { source: "AP", target: "C", type: "ADOPTIVE_PARENT_OF" },
  ];
  expect(isMarriedIn("C", edges)).toBe(false);
});

test("placeNodes: a blood column keeps dagre's vertical positions (immovable)", () => {
  // F is parent of A and B; gaps already exceed ROW, so nothing shifts.
  const edges: GraphEdge[] = [
    { source: "F", target: "A", type: "PARENT_OF" },
    { source: "F", target: "B", type: "PARENT_OF" },
  ];
  const input = pos([
    ["F", [0, 50]],
    ["A", [100, 0]],
    ["B", [100, 100]],
  ]);

  expect(obj(placeNodes(input, edges, "F", ROW))).toEqual({
    F: { x: 0, y: 50 },
    A: { x: 100, y: 0 },
    B: { x: 100, y: 100 },
  });
});

test("placeNodes: a married-in spouse is pulled into the host's column and tucked below them", () => {
  // W married F but dagre left her in her own column (x=200); she has no parent
  // edge, so she's the only movable node. She lands in F's column, one ROW below F.
  const edges: GraphEdge[] = [
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "W", type: "SPOUSE_OF" },
  ];
  const input = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
    ["W", [200, 0]],
  ]);

  expect(obj(placeNodes(input, edges, "C", ROW))).toEqual({
    F: { x: 0, y: 0 },
    C: { x: 100, y: 0 },
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

  // W ends one ROW below F2 (146), proving the focus won the host tie.
  expect(obj(placeNodes(input, edges, "F2", ROW))).toEqual({
    F1: { x: 0, y: 0 },
    F2: { x: 0, y: 100 },
    W: { x: 0, y: 146 },
    C1: { x: 100, y: 0 },
    C2: { x: 100, y: 100 },
  });
});

test("placeNodes: the focus's own spouse who heads a blood line is tucked beside the focus", () => {
  // FO and S are spouses, both with their own descent (not married-in), in the
  // same column. dagre stacked S at the bottom (y=300); the focus-spouse rule
  // pulls S up to sit right below FO, ahead of FO's siblings X, Y.
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

  expect(obj(placeNodes(input, edges, "FO", ROW))).toEqual({
    PA: { x: -100, y: 50 },
    PB: { x: -100, y: 300 },
    FO: { x: 0, y: 0 },
    S: { x: 0, y: 46 },
    X: { x: 0, y: 100 },
    Y: { x: 0, y: 200 },
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

  expect(obj(placeNodes(input, edges, "FO", ROW))).toEqual({
    PA: { x: -100, y: 50 },
    PB: { x: -100, y: 200 },
    FO: { x: 0, y: 0 },
    S: { x: 0, y: 46 },
  });
});

test("placeNodes: an adoptive parent of the focus drops below the sibling cluster", () => {
  // AP enters in the parent column on FO's row (overlapping the blood father PA).
  // It is moved below FO's column cluster (which bottoms at X's y=100), still in
  // the parent column so its arrow keeps pointing right.
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

  expect(obj(placeNodes(input, edges, "FO", ROW))).toEqual({
    PA: { x: -100, y: 0 },
    FO: { x: 0, y: 0 },
    X: { x: 0, y: 100 },
    AP: { x: -100, y: 146 },
  });
});

test("placeNodes: multiple adoptive parents are stacked one ROW apart below the cluster", () => {
  // AP1, AP2 both enter on FO's row in the parent column; both drop below FO's
  // column cluster (bottoms at sib's y=100) and stack in edge order: 146, then 192.
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

  expect(obj(placeNodes(input, edges, "FO", ROW))).toEqual({
    PA: { x: -100, y: 0 },
    FO: { x: 0, y: 0 },
    sib: { x: 0, y: 100 },
    AP1: { x: -100, y: 146 },
    AP2: { x: -100, y: 192 },
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

  expect(obj(placeNodes(input, edges, "FO", ROW))).toEqual({
    N: { x: -100, y: 0 },
    FO: { x: 0, y: 0 },
  });
});

test("spouseRouting: a clear marriage line is not routed", () => {
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 0]],
    ["T", [0, 46]],
  ]);

  expect(spouseRouting(input, edges, GUTTER)).toEqual([]);
});

test("spouseRouting: a line blocked by an unrelated node is bowed", () => {
  // U sits on the midline between S and T and is no co-spouse, so the line detours.
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 0]],
    ["T", [0, 200]],
    ["U", [0, 100]],
  ]);

  expect(spouseRouting(input, edges, GUTTER)).toEqual([
    { edgeId: "S|SPOUSE_OF|T", bow: 70 },
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

  expect(spouseRouting(input, edges, GUTTER)).toEqual([]);
});

test("spouseRouting: the bow sign follows the source→target vertical direction", () => {
  // Source below target: the bow flips negative.
  const edges: GraphEdge[] = [{ source: "S", target: "T", type: "SPOUSE_OF" }];
  const input = pos([
    ["S", [0, 200]],
    ["T", [0, 0]],
    ["U", [0, 100]],
  ]);

  expect(spouseRouting(input, edges, GUTTER)).toEqual([
    { edgeId: "S|SPOUSE_OF|T", bow: -70 },
  ]);
});

test("placeNodes: an empty graph yields an empty map", () => {
  expect(obj(placeNodes(new Map(), [], "anyone", ROW))).toEqual({});
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

  expect(obj(placeNodes(input, edges, "MISSING", ROW))).toEqual({
    F: { x: 0, y: 0 },
    C: { x: 100, y: 0 },
    W: { x: 0, y: 46 },
  });
});

test("spouseRouting: a graph with no marriage edges routes nothing", () => {
  const edges: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const input = pos([
    ["F", [0, 0]],
    ["C", [100, 0]],
  ]);

  expect(spouseRouting(input, edges, GUTTER)).toEqual([]);
});

test("spouseRouting: an empty graph routes nothing", () => {
  expect(spouseRouting(new Map(), [], GUTTER)).toEqual([]);
});

const graph = (
  nodes: [string, string | undefined][],
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
  // C already sits on the midpoint (centerOnlyChildren ran in the real flow), so
  // the junction stays at the couple's midpoint.
  const positions = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["C", [100, 23]],
  ]);

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([
    {
      id: "__junction__|F|M",
      pos: { x: 0, y: 23 },
      children: ["C"],
      hiddenEdgeIds: ["F|PARENT_OF|C"],
    },
  ]);
});

test("descentJunctions: a lone child stuck on the father's row drops the junction onto that row (#28)", () => {
  // C couldn't be centered onto the midpoint — a fixed blood spouse S pinned
  // directly below it aborts centerOnlyChildren's shift — so C stays on F's row.
  // The junction follows C onto that row (here = F's), straightening the line,
  // instead of staying at the midpoint and jogging a half row.
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["C", "female"],
      ["S", "male"],
    ],
    [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
      { source: "C", target: "S", type: "SPOUSE_OF" },
    ],
  );
  const drawn: GraphEdge[] = [{ source: "F", target: "C", type: "PARENT_OF" }];
  const positions = pos([
    ["F", [0, 0]],
    ["M", [0, 46]],
    ["C", [100, 0]],
    ["S", [100, 46]], // blood spouse pinned below C, blocking the center shift
  ]);

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([
    {
      id: "__junction__|F|M",
      pos: { x: 0, y: 0 }, // dropped to C's row, not the midpoint (0, 23)
      children: ["C"],
      hiddenEdgeIds: ["F|PARENT_OF|C"],
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([
    {
      id: "__junction__|F|M",
      pos: { x: 0, y: 23 },
      children: ["C1", "C2"],
      hiddenEdgeIds: ["F|PARENT_OF|C1", "F|PARENT_OF|C2"],
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([
    {
      id: "__junction__|F|M1",
      pos: { x: 0, y: 23 },
      children: ["C"],
      hiddenEdgeIds: ["F|PARENT_OF|C"],
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
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

  expect(descentJunctions(g, drawn, positions, ROW)).toEqual([]);
});

test("centerOnlyChildren: the focus's blood-line spouse rides along to the midpoint (#30)", () => {
  // Couple F+M's only child is the focus FO, sitting on F's row while M is one
  // ROW below; the midpoint is half a row under FO, so centering wants to drop FO
  // by 23. FO's spouse S heads her own blood line (not married-in) and is tucked
  // right below FO. The old mover set kept only married-in spouses, so S was read
  // as a fixed neighbour one ROW below — pinning the shift to 0 (the jog stayed).
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["FO", "male"],
      ["S", "female"],
      ["PS", "male"],
    ],
    [
      { source: "F", target: "FO", type: "PARENT_OF" },
      { source: "M", target: "FO", type: "PARENT_OF" },
      { source: "PS", target: "S", type: "PARENT_OF" },
      { source: "FO", target: "S", type: "SPOUSE_OF" },
    ],
  );
  // Patrilineal view: M's descent edge is dropped, so only F→FO is drawn.
  const drawn: GraphEdge[] = [
    { source: "F", target: "FO", type: "PARENT_OF" },
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

  expect(obj(centerOnlyChildren(input, g, drawn, "FO", ROW))).toEqual({
    F: { x: 0, y: 0 },
    M: { x: 0, y: 46 },
    FO: { x: 100, y: 23 }, // on the midpoint, line straightened
    S: { x: 100, y: 69 }, // rode along, couple spacing preserved
    PS: { x: 200, y: 0 },
  });
});

test("centerOnlyChildren: a transitive co-spouse below the focus's spouse rides along (#30)", () => {
  // As above, but S in turn has a married-in co-spouse T tucked below her. T is
  // two hops from FO (FO→S→T), past the reach of a direct-spouse lookup, so the
  // old mover set left T fixed and again clamped the shift to 0.
  const g = graph(
    [
      ["F", "male"],
      ["M", "female"],
      ["FO", "male"],
      ["S", "female"],
      ["T", "female"],
      ["PS", "male"],
    ],
    [
      { source: "F", target: "FO", type: "PARENT_OF" },
      { source: "M", target: "FO", type: "PARENT_OF" },
      { source: "PS", target: "S", type: "PARENT_OF" },
      { source: "FO", target: "S", type: "SPOUSE_OF" },
      { source: "S", target: "T", type: "SPOUSE_OF" },
    ],
  );
  const drawn: GraphEdge[] = [
    { source: "F", target: "FO", type: "PARENT_OF" },
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

  expect(obj(centerOnlyChildren(input, g, drawn, "FO", ROW))).toEqual({
    F: { x: 0, y: 0 },
    M: { x: 0, y: 46 },
    FO: { x: 100, y: 23 },
    S: { x: 100, y: 69 },
    T: { x: 100, y: 115 }, // transitive co-spouse rode along too
    PS: { x: 200, y: 0 },
  });
});
