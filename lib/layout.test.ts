import { expect, test } from "bun:test";
import { isMarriedIn, placeNodes, spouseRouting } from "./layout";
import type { GraphEdge } from "./graph";

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
