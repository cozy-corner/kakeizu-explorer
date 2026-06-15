import { expect, test } from "bun:test";
import { neighborsToGraph, pathToGraph, personsToGraph } from "./graph";

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
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
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
      type: null,
      bQid: null,
      bLabel: null,
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
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
    },
    // Same node reached again via a different walk, plus the same edge repeated.
    {
      aQid: "Q171411",
      aLabel: "織田信長",
      type: "PARENT_OF",
      bQid: "Q1234",
      bLabel: "織田信忠",
    },
    { aQid: "Q1234", aLabel: "織田信忠", type: null, bQid: null, bLabel: null },
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
