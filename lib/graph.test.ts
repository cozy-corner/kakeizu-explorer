import { expect, test } from "bun:test";
import { personsToGraph } from "./graph";

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
