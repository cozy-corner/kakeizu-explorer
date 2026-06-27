import { expect, test } from "bun:test";
import {
  egoDrawnEdges,
  type Graph,
  type GraphEdge,
  layoutOnlyEdges,
  neighborsToGraph,
  patrilinealEdges,
  pathToGraph,
  personsToGraph,
  siblingAdoptiveEdges,
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
  const graph: Graph = {
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
  const graph: Graph = {
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
  const graph: Graph = {
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
  const graph: Graph = {
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
  const graph: Graph = {
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
  const graph: Graph = {
    nodes: [
      { qid: "A", label: "兄", sex: "male" },
      { qid: "B", label: "弟", sex: "male" },
    ],
    edges: [{ source: "A", target: "B", type: "SIBLING_OF" }],
  };

  expect(patrilinealEdges(graph)).toEqual([]);
});

test("layout-only: surfaces the dropped mother→child edge so the couple co-ranks", () => {
  const graph: Graph = {
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
  const motherOnly: Graph = {
    nodes: [
      { qid: "M", label: "母", sex: "female" },
      { qid: "C", label: "子" },
    ],
    edges: [{ source: "M", target: "C", type: "PARENT_OF" }],
  };
  const twoFathers: Graph = {
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

test("sibling adoptive: flags a kin-succession adoption between two blood siblings", () => {
  // 頼職→吉宗 shape: both are blood children of the SAME father, so siblings and the
  // same generation. The adoption is succession, not descent — dropped so it neither
  // feeds dagre (would over-rank 吉宗 a column deeper than his brother) nor draws (a
  // false second descent into 吉宗).
  const edges: GraphEdge[] = [
    { source: "P", target: "elder", type: "PARENT_OF" },
    { source: "P", target: "younger", type: "PARENT_OF" },
    { source: "elder", target: "younger", type: "ADOPTIVE_PARENT_OF" },
  ];

  expect(siblingAdoptiveEdges(edges)).toEqual([
    { source: "elder", target: "younger", type: "ADOPTIVE_PARENT_OF" },
  ]);
});

test("sibling adoptive: keeps a cross-generation adoption between non-siblings", () => {
  // 斉彊→家茂 shape: an uncle adopts a nephew. Both are blood-placed, but they do
  // NOT share a parent (家斉→斉彊, but 斉順→家茂), so it is a genuine cross-generation
  // descent line and must be kept. Regression guard: a blanket "both blood-placed"
  // rule wrongly dropped this.
  const edges: GraphEdge[] = [
    { source: "GF", target: "uncle", type: "PARENT_OF" },
    { source: "GF", target: "parent", type: "PARENT_OF" },
    { source: "parent", target: "nephew", type: "PARENT_OF" },
    { source: "uncle", target: "nephew", type: "ADOPTIVE_PARENT_OF" },
  ];

  expect(siblingAdoptiveEdges(edges)).toEqual([]);
});

test("sibling adoptive: keeps an adoption where an endpoint has no in-view blood parent", () => {
  // The adopted child or adoptive parent has no shown blood parent, so they can't be
  // siblings — a genuine descent (an adoptive parent 家継→吉宗, or an adopted child
  // 吉宗→雲松院) that must both rank and draw.
  const adoptiveParentUnpinned: GraphEdge[] = [
    { source: "P", target: "C", type: "PARENT_OF" },
    { source: "AP", target: "C", type: "ADOPTIVE_PARENT_OF" }, // AP has no blood parent
  ];
  const adoptedChildUnpinned: GraphEdge[] = [
    { source: "P", target: "F", type: "PARENT_OF" },
    { source: "F", target: "AC", type: "ADOPTIVE_PARENT_OF" }, // AC has no blood parent
  ];

  expect(siblingAdoptiveEdges(adoptiveParentUnpinned)).toEqual([]);
  expect(siblingAdoptiveEdges(adoptedChildUnpinned)).toEqual([]);
});

test("ego drawn: patrilineal reduction with sibling adoptions dropped", () => {
  // 頼職→吉宗 shape: the sibling adoption is dropped from the drawn set, the blood
  // descent lines stay. This is the composition the ego view and dump-layout share.
  const graph: Graph = {
    nodes: [
      { qid: "P", label: "父", sex: "male" },
      { qid: "elder", label: "兄", sex: "male" },
      { qid: "younger", label: "弟", sex: "male" },
    ],
    edges: [
      { source: "P", target: "elder", type: "PARENT_OF" },
      { source: "P", target: "younger", type: "PARENT_OF" },
      { source: "elder", target: "younger", type: "ADOPTIVE_PARENT_OF" },
    ],
  };

  expect(egoDrawnEdges(graph)).toEqual([
    { source: "P", target: "elder", type: "PARENT_OF" },
    { source: "P", target: "younger", type: "PARENT_OF" },
  ]);
});

test("ego drawn: keeps a cross-generation adoption", () => {
  // 斉彊→家茂 shape: uncle adopts nephew, not siblings — a genuine descent line that
  // must stay in the drawn set.
  const graph: Graph = {
    nodes: [
      { qid: "GF", label: "祖父", sex: "male" },
      { qid: "uncle", label: "叔父", sex: "male" },
      { qid: "parent", label: "親", sex: "male" },
      { qid: "nephew", label: "甥", sex: "male" },
    ],
    edges: [
      { source: "GF", target: "uncle", type: "PARENT_OF" },
      { source: "GF", target: "parent", type: "PARENT_OF" },
      { source: "parent", target: "nephew", type: "PARENT_OF" },
      { source: "uncle", target: "nephew", type: "ADOPTIVE_PARENT_OF" },
    ],
  };

  expect(egoDrawnEdges(graph)).toContainEqual({
    source: "uncle",
    target: "nephew",
    type: "ADOPTIVE_PARENT_OF",
  });
});
