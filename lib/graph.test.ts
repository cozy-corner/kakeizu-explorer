import { expect, test } from "bun:test";
import {
  layoutOnlyEdges,
  neighborsToGraph,
  patrilinealEdges,
  pathToGraph,
  personsToGraph,
} from "./graph";

test("maps person rows into graph nodes, preserving qid and label", () => {
  const graph = personsToGraph([
    { qid: "Q171411", label: "織田信長" },
    { qid: "Q171977", label: "徳川家康" },
  ]);

  expect(graph.nodes).toEqual([
    { qid: "Q171411", label: "織田信長" },
    { qid: "Q171977", label: "徳川家康" },
  ]);
});

test("search returns no edges (people only)", () => {
  const graph = personsToGraph([{ qid: "Q171411", label: "織田信長" }]);

  expect(graph.edges).toEqual([]);
});

test("returns an empty graph for no matches", () => {
  expect(personsToGraph([])).toEqual({ nodes: [], edges: [] });
});

test("neighbors: builds nodes and edges, mapping the relationship type", () => {
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
    },
  ]);

  expect(graph).toEqual({
    nodes: [
      { qid: "Q171411", label: "織田信長" },
      { qid: "Q1234", label: "織田信忠" },
    ],
    edges: [{ source: "Q171411", target: "Q1234", type: "PARENT_OF" }],
  });
});

test("neighbors: an isolated focus person yields one node and no edges", () => {
  // The focus node always comes back as an `a` row with a null edge.
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      type: null,
      bQid: null,
      bLabel: null,
      bSex: null,
    },
  ]);

  expect(graph).toEqual({
    nodes: [{ qid: "Q171411", label: "織田信長" }],
    edges: [],
  });
});

test("neighbors: dedupes repeated nodes and edges", () => {
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
    },
    // Same node reached again via a different walk, plus the same edge repeated.
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
    },
    {
      aQid: "Q1234",
      aLabel: "織田信忠",
      aSex: null,
      type: null,
      bQid: null,
      bLabel: null,
      bSex: null,
    },
  ]);

  expect(graph.nodes).toEqual([
    { qid: "Q171411", label: "織田信長" },
    { qid: "Q1234", label: "織田信忠" },
  ]);
  expect(graph.edges).toEqual([
    { source: "Q171411", target: "Q1234", type: "PARENT_OF" },
  ]);
});

test("neighbors: returns an empty graph when the person is not found", () => {
  expect(neighborsToGraph([])).toEqual({ nodes: [], edges: [] });
});

test("path: builds an ordered node chain and edges from hop rows", () => {
  // One row per relationship, in path order: 信長 -[SPOUSE_OF]- 帰蝶 -[PARENT_OF]- 家康.
  const graph = pathToGraph([
    {
      sourceQid: "Q171411",
      sourceLabel: "織田信長",
      targetQid: "Q231562",
      targetLabel: "濃姫",
      type: "SPOUSE_OF",
    },
    {
      sourceQid: "Q231562",
      sourceLabel: "濃姫",
      targetQid: "Q171977",
      targetLabel: "徳川家康",
      type: "PARENT_OF",
    },
  ]);

  expect(graph).toEqual({
    nodes: [
      { qid: "Q171411", label: "織田信長" },
      { qid: "Q231562", label: "濃姫" },
      { qid: "Q171977", label: "徳川家康" },
    ],
    edges: [
      { source: "Q171411", target: "Q231562", type: "SPOUSE_OF" },
      { source: "Q231562", target: "Q171977", type: "PARENT_OF" },
    ],
  });
});

test("path: returns an empty graph when there is no path", () => {
  expect(pathToGraph([])).toEqual({ nodes: [], edges: [] });
});

test("neighbors: carries each node's sex through", () => {
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: "male",
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "徳姫",
      bSex: "female",
    },
  ]);

  expect(graph.nodes).toEqual([
    { qid: "Q171411", label: "織田信長", sex: "male" },
    { qid: "Q1234", label: "徳姫", sex: "female" },
  ]);
});

test("patrilineal: a child with both parents descends from the father only", () => {
  const graph = {
    nodes: [
      { qid: "F", label: "父", sex: "male" },
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子", sex: "male" },
    ],
    edges: [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
      { source: "F", target: "M", type: "SPOUSE_OF" },
    ],
  };

  expect(patrilinealEdges(graph)).toEqual([
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "M", type: "SPOUSE_OF" },
  ]);
});

test("patrilineal: falls back to any parent when no father is known", () => {
  const graph = {
    nodes: [
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子" }, // child of a mother only
    ],
    edges: [{ source: "M", target: "C", type: "PARENT_OF" }],
  };

  expect(patrilinealEdges(graph)).toEqual([
    { source: "M", target: "C", type: "PARENT_OF" },
  ]);
});

test("patrilineal: a child with two recorded fathers keeps both father edges", () => {
  const graph = {
    nodes: [
      { qid: "F1", label: "父1", sex: "male" },
      { qid: "F2", label: "父2", sex: "male" },
      { qid: "C", label: "子", sex: "female" },
    ],
    edges: [
      { source: "F1", target: "C", type: "PARENT_OF" },
      { source: "F2", target: "C", type: "PARENT_OF" },
    ],
  };

  // Disputed/uncertain parentage: keep both rather than arbitrarily picking one.
  expect(patrilinealEdges(graph)).toEqual([
    { source: "F1", target: "C", type: "PARENT_OF" },
    { source: "F2", target: "C", type: "PARENT_OF" },
  ]);
});

test("patrilineal: an unknown-sex parent is kept as a descent line, not hidden", () => {
  const graph = {
    nodes: [
      { qid: "F", label: "父", sex: undefined }, // P21 not fetched
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子", sex: "male" },
    ],
    edges: [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
      { source: "F", target: "M", type: "SPOUSE_OF" },
    ],
  };

  // Only the confirmed mother is dropped; the unknown-sex parent stays the line.
  expect(patrilinealEdges(graph)).toEqual([
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "M", type: "SPOUSE_OF" },
  ]);
});

test("patrilineal: a spouse-less mother is linked to the father via her shared child", () => {
  const graph = {
    nodes: [
      { qid: "F", label: "父", sex: "male" },
      { qid: "M", label: "母", sex: "female" }, // no SPOUSE_OF recorded
      { qid: "C", label: "子", sex: "male" },
    ],
    edges: [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
    ],
  };

  // Mother→child is dropped; a co-parent SPOUSE_OF is synthesized so she sits
  // beside the father instead of floating.
  expect(patrilinealEdges(graph)).toEqual([
    { source: "F", target: "C", type: "PARENT_OF" },
    { source: "F", target: "M", type: "SPOUSE_OF" },
  ]);
});

test("patrilineal: drops sibling edges entirely", () => {
  const graph = {
    nodes: [
      { qid: "A", label: "兄", sex: "male" },
      { qid: "B", label: "弟", sex: "male" },
    ],
    edges: [{ source: "A", target: "B", type: "SIBLING_OF" }],
  };

  expect(patrilinealEdges(graph)).toEqual([]);
});

test("layout-only: surfaces the dropped mother→child edge so the couple co-ranks", () => {
  const graph = {
    nodes: [
      { qid: "F", label: "父", sex: "male" },
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子", sex: "male" },
    ],
    edges: [
      { source: "F", target: "C", type: "PARENT_OF" },
      { source: "M", target: "C", type: "PARENT_OF" },
      { source: "F", target: "M", type: "SPOUSE_OF" },
    ],
  };

  // The mother's descent line is dropped from drawing but re-emitted as a
  // hidden layout edge, so dagre seats her in the father's generation column.
  expect(layoutOnlyEdges(graph)).toEqual([
    { source: "M", target: "C", type: "LAYOUT" },
  ]);
});

test("layout-only: no extra edges when every parent is already a drawn line", () => {
  // No father → both parents stay drawn; two fathers → both stay drawn. Nothing
  // is dropped, so there is no hidden edge to add.
  const motherOnly = {
    nodes: [
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子" },
    ],
    edges: [{ source: "M", target: "C", type: "PARENT_OF" }],
  };
  const twoFathers = {
    nodes: [
      { qid: "F1", label: "父1", sex: "male" },
      { qid: "F2", label: "父2", sex: "male" },
      { qid: "C", label: "子", sex: "female" },
    ],
    edges: [
      { source: "F1", target: "C", type: "PARENT_OF" },
      { source: "F2", target: "C", type: "PARENT_OF" },
    ],
  };

  expect(layoutOnlyEdges(motherOnly)).toEqual([]);
  expect(layoutOnlyEdges(twoFathers)).toEqual([]);
});
