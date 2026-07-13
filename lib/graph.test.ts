import { expect, test } from "bun:test";
import {
  egoDrawnEdges,
  type Graph,
  type GraphEdge,
  layoutOnlyEdges,
  mergeGraph,
  neighborsToGraph,
  patrilinealEdges,
  pathToGraph,
  type PersonId,
  personsToGraph,
  siblingAdoptiveEdges,
  spouseAdoptiveEdges,
  withoutAdoptions,
} from "./graph";

test("maps person rows into graph nodes, preserving qid, label and wikipediaTitle", () => {
  const graph = personsToGraph([
    // wikipediaTitle differs from label (disambiguation) — the article pane must
    // open the canonical title, not the label.
    { qid: "Q171411", label: "織田信長", wikipediaTitle: "織田信長 (人物)" },
    // No ja.wikipedia article → null from the DB → undefined so the pane falls
    // back to label.
    { qid: "Q171977", label: "徳川家康", wikipediaTitle: null },
  ]);

  expect(graph.nodes).toEqual([
    { qid: "Q171411", label: "織田信長", wikipediaTitle: "織田信長 (人物)" },
    { qid: "Q171977", label: "徳川家康", wikipediaTitle: undefined },
  ]);
});

test("search returns no edges (people only)", () => {
  const graph = personsToGraph([
    { qid: "Q171411", label: "織田信長", wikipediaTitle: null },
  ]);

  expect(graph.edges).toEqual([]);
});

test("returns an empty graph for no matches", () => {
  expect(personsToGraph([])).toEqual({ nodes: [], edges: [] });
});

test("neighbors: builds nodes and edges, mapping the relationship type and wikipediaTitle", () => {
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      aWikipediaTitle: "織田信長 (人物)", // differs from label
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
      bWikipediaTitle: null, // no ja.wikipedia article → falls back to label
    },
  ]);

  expect(graph).toEqual({
    nodes: [
      { qid: "Q171411", label: "織田信長", wikipediaTitle: "織田信長 (人物)" },
      { qid: "Q1234", label: "織田信忠", wikipediaTitle: undefined },
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
      aWikipediaTitle: null,
      type: null,
      bQid: null,
      bLabel: null,
      bSex: null,
      bWikipediaTitle: null,
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
      aWikipediaTitle: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
      bWikipediaTitle: null,
    },
    // Same node reached again via a different walk, plus the same edge repeated.
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: null,
      aWikipediaTitle: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
      bSex: null,
      bWikipediaTitle: null,
    },
    {
      aQid: "Q1234",
      aLabel: "織田信忠",
      aSex: null,
      aWikipediaTitle: null,
      type: null,
      bQid: null,
      bLabel: null,
      bSex: null,
      bWikipediaTitle: null,
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
      sourceWikipediaTitle: "織田信長 (人物)", // differs from label
      targetQid: "Q231562",
      targetLabel: "濃姫",
      targetWikipediaTitle: null, // no article → falls back to label
      type: "SPOUSE_OF",
    },
    {
      sourceQid: "Q231562",
      sourceLabel: "濃姫",
      sourceWikipediaTitle: null,
      targetQid: "Q171977",
      targetLabel: "徳川家康",
      targetWikipediaTitle: null,
      type: "PARENT_OF",
    },
  ]);

  expect(graph).toEqual({
    nodes: [
      { qid: "Q171411", label: "織田信長", wikipediaTitle: "織田信長 (人物)" },
      { qid: "Q231562", label: "濃姫", wikipediaTitle: undefined },
      { qid: "Q171977", label: "徳川家康", wikipediaTitle: undefined },
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

test("merge: unions nodes and edges, deduping the overlap", () => {
  // Two hops-1 fires that share the middle person and the A→B edge.
  const a: Graph = {
    nodes: [
      { qid: "A", label: "甲" },
      { qid: "B", label: "乙" },
    ],
    edges: [{ source: "A", target: "B", type: "PARENT_OF" }],
  };
  const b: Graph = {
    nodes: [
      { qid: "B", label: "乙" },
      { qid: "C", label: "丙" },
    ],
    edges: [
      { source: "A", target: "B", type: "PARENT_OF" },
      { source: "B", target: "C", type: "PARENT_OF" },
    ],
  };

  expect(mergeGraph(a, b)).toEqual({
    nodes: [
      { qid: "A", label: "甲" },
      { qid: "B", label: "乙" },
      { qid: "C", label: "丙" },
    ],
    edges: [
      { source: "A", target: "B", type: "PARENT_OF" },
      { source: "B", target: "C", type: "PARENT_OF" },
    ],
  });
});

test("merge: same pair with different edge types stays as two edges", () => {
  // Adoption and blood between the same two people are distinct edges (key includes type).
  const a: Graph = {
    nodes: [{ qid: "A", label: "甲" }],
    edges: [{ source: "A", target: "B", type: "PARENT_OF" }],
  };
  const b: Graph = {
    nodes: [{ qid: "A", label: "甲" }],
    edges: [{ source: "A", target: "B", type: "ADOPTIVE_PARENT_OF" }],
  };

  expect(mergeGraph(a, b).edges).toEqual([
    { source: "A", target: "B", type: "PARENT_OF" },
    { source: "A", target: "B", type: "ADOPTIVE_PARENT_OF" },
  ]);
});

test("neighbors: carries each node's sex through", () => {
  const graph = neighborsToGraph([
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      aSex: "male",
      aWikipediaTitle: null,
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "徳姫",
      bSex: "female",
      bWikipediaTitle: null,
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

test("spouse adoptive: flags an adoptive edge between two people also married (淀殿 shape)", () => {
  const edges: GraphEdge[] = [
    { source: "focus", target: "yodo", type: "ADOPTIVE_PARENT_OF" },
    { source: "focus", target: "yodo", type: "SPOUSE_OF" },
  ];

  expect(spouseAdoptiveEdges(edges)).toEqual([
    { source: "focus", target: "yodo", type: "ADOPTIVE_PARENT_OF" },
  ]);
});

test("spouse adoptive: matches regardless of edge direction (unordered pair)", () => {
  // SPOUSE_OF is stored in one arbitrary direction, ADOPTIVE_PARENT_OF focus→child.
  const edges: GraphEdge[] = [
    { source: "focus", target: "yodo", type: "ADOPTIVE_PARENT_OF" },
    { source: "yodo", target: "focus", type: "SPOUSE_OF" },
  ];

  expect(spouseAdoptiveEdges(edges)).toEqual([
    { source: "focus", target: "yodo", type: "ADOPTIVE_PARENT_OF" },
  ]);
});

test("spouse adoptive: keeps a 婿養子 adoption (adopter and spouse are different people)", () => {
  // X adopts the son-in-law, who marries X's daughter. The adoptive pair (X, son)
  // is not the married pair (son, daughter), so the real adoptive descent survives.
  const edges: GraphEdge[] = [
    { source: "X", target: "son", type: "ADOPTIVE_PARENT_OF" },
    { source: "son", target: "daughter", type: "SPOUSE_OF" },
    { source: "X", target: "daughter", type: "PARENT_OF" },
  ];

  expect(spouseAdoptiveEdges(edges)).toEqual([]);
});

test("ego drawn: drops an adoptive edge between a married couple, keeps the marriage", () => {
  const graph: Graph = {
    nodes: [
      { qid: "focus", label: "秀吉", sex: "male" },
      { qid: "yodo", label: "淀殿", sex: "female" },
      { qid: "child", label: "秀頼", sex: "male" },
    ],
    edges: [
      { source: "focus", target: "yodo", type: "ADOPTIVE_PARENT_OF" },
      { source: "focus", target: "yodo", type: "SPOUSE_OF" },
      { source: "focus", target: "child", type: "PARENT_OF" },
      { source: "yodo", target: "child", type: "PARENT_OF" },
    ],
  };

  const drawn = egoDrawnEdges(graph);
  expect(drawn).not.toContainEqual({
    source: "focus",
    target: "yodo",
    type: "ADOPTIVE_PARENT_OF",
  });
  expect(drawn).toContainEqual({
    source: "focus",
    target: "yodo",
    type: "SPOUSE_OF",
  });
});

test("ego drawn: co-parenting (no recorded marriage) still reclassifies the adoptive edge as a spouse", () => {
  // The adopter and adoptee share a child but have no recorded SPOUSE_OF.
  // patrilinealEdges synthesizes a co-parent marriage, and that synthesized edge
  // is enough to treat the pair as spouses — sharing a child means they ARE the
  // reproductive couple, so spouse placement (not adopted-child) is correct.
  const graph: Graph = {
    nodes: [
      { qid: "focus", label: "焦点", sex: "male" },
      { qid: "partner", label: "配偶者", sex: "female" },
      { qid: "child", label: "子", sex: "male" },
    ],
    edges: [
      { source: "focus", target: "partner", type: "ADOPTIVE_PARENT_OF" },
      { source: "focus", target: "child", type: "PARENT_OF" },
      { source: "partner", target: "child", type: "PARENT_OF" },
    ],
  };

  const drawn = egoDrawnEdges(graph);
  expect(drawn).not.toContainEqual({
    source: "focus",
    target: "partner",
    type: "ADOPTIVE_PARENT_OF",
  });
  expect(drawn).toContainEqual({
    source: "focus",
    target: "partner",
    type: "SPOUSE_OF",
  });
});

test("withoutAdoptions: drops the adoptive edge and the now-orphaned 養父", () => {
  const graph: Graph = {
    nodes: [
      { qid: "ego", label: "養子", sex: "male" },
      { qid: "father", label: "実父", sex: "male" },
      { qid: "adopter", label: "養父", sex: "male" },
    ],
    edges: [
      { source: "father", target: "ego", type: "PARENT_OF" },
      { source: "adopter", target: "ego", type: "ADOPTIVE_PARENT_OF" },
    ],
  };

  expect(withoutAdoptions(graph, "ego" as PersonId)).toEqual({
    nodes: [
      { qid: "ego", label: "養子", sex: "male" },
      { qid: "father", label: "実父", sex: "male" },
    ],
    edges: [{ source: "father", target: "ego", type: "PARENT_OF" }],
  });
});

test("withoutAdoptions: drops a floating 養父+養母 couple unreachable from focus", () => {
  const graph: Graph = {
    nodes: [
      { qid: "ego", label: "養子", sex: "male" },
      { qid: "father", label: "実父", sex: "male" },
      { qid: "adopter", label: "養父", sex: "male" },
      { qid: "adoptMother", label: "養母", sex: "female" },
    ],
    edges: [
      { source: "father", target: "ego", type: "PARENT_OF" },
      { source: "adopter", target: "ego", type: "ADOPTIVE_PARENT_OF" },
      // 養父 hangs onto 養母 by marriage; neither reaches the blood tree once the
      // adoptive edge is gone, so both must fall away rather than float.
      { source: "adopter", target: "adoptMother", type: "SPOUSE_OF" },
    ],
  };

  expect(
    withoutAdoptions(graph, "ego" as PersonId).nodes.map((n) => n.qid),
  ).toEqual(["ego", "father"]);
});

test("withoutAdoptions: keeps an adoptive parent who is also blood-connected", () => {
  // Uncle adopts nephew (家督 succession), but both descend from the grandfather,
  // so the uncle stays on the blood tree; only the adoptive edge is stripped.
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

  const result = withoutAdoptions(graph, "nephew" as PersonId);
  expect(result.nodes.map((n) => n.qid).sort()).toEqual([
    "GF",
    "nephew",
    "parent",
    "uncle",
  ]);
  expect(result.edges).not.toContainEqual({
    source: "uncle",
    target: "nephew",
    type: "ADOPTIVE_PARENT_OF",
  });
});

test("withoutAdoptions: keeps an isolated focus with no edges", () => {
  const graph: Graph = {
    nodes: [{ qid: "ego", label: "本人", sex: "male" }],
    edges: [],
  };

  expect(withoutAdoptions(graph, "ego" as PersonId)).toEqual(graph);
});
