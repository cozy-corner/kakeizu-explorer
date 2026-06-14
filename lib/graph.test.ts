import { expect, test } from "bun:test";
import { neighborsToGraph, personsToGraph } from "./graph";

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
