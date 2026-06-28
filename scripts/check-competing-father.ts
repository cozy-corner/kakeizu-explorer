// Regression guard for the competing-father filter in the neighbors API
// (app/api/person/[id]/neighbors/route.ts). The rule lives in a Cypher string,
// so it can only be exercised against the live DB — same constraint as
// layout-parity.ts. Asserts on real ego graphs:
//   - 頼朝 (paternal ego): 大友能直's competing father 近藤能成 is dropped together
//     with everyone reachable only through him, while the mother 利根局 and the
//     child 大友能直 stay and nothing floats. Checked at hops=2 AND hops=3 — the
//     branch-pruning only matters at hops≥3, where 近藤's own kin would leak.
//   - 北条政子 (female ego): her children's father 頼朝 is NOT dropped.
//
// Run with the dev server up: bun run scripts/check-competing-father.ts
import type { Graph } from "../lib/graph";

async function ego(qid: string, hops: number): Promise<Graph> {
  const res = await fetch(
    `http://localhost:3000/api/person/${encodeURIComponent(qid)}/neighbors?hops=${hops}`,
  );
  if (!res.ok) {
    throw new Error(
      `ego(${qid}, ${hops}) failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as Graph;
}

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
}

// A node other than the focus with no incident edge — a branch the filter
// half-removed (dropped the father but left his kin dangling).
function floating(graph: Graph, focus: string): string[] {
  const connected = new Set<string>();
  for (const e of graph.edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  return graph.nodes
    .filter((n) => n.qid !== focus && !connected.has(n.qid))
    .map((n) => n.qid);
}

// 頼朝 — the competing-father case the filter targets. hops=3 is where 近藤's own
// relatives would leak in as floating nodes if only the father (not the branch)
// were dropped.
for (const hops of [2, 3]) {
  const g = await ego("Q242800", hops);
  const qids = new Set(g.nodes.map((n) => n.qid));
  check(
    `頼朝 hops=${hops}: 近藤能成 (Q106592356) dropped`,
    !qids.has("Q106592356"),
  );
  check(
    `頼朝 hops=${hops}: mother 利根局 (Q106595994) kept`,
    qids.has("Q106595994"),
  );
  check(
    `頼朝 hops=${hops}: child 大友能直 (Q11433255) kept`,
    qids.has("Q11433255"),
  );
  const fl = floating(g, "Q242800");
  check(
    `頼朝 hops=${hops}: no floating node${fl.length ? ` (${fl.join(", ")})` : ""}`,
    fl.length === 0,
  );
}

// 北条政子 — a female ego must keep the father of her children (the filter must
// not fire for a non-paternal focus).
const masako = await ego("Q463961", 2);
const mQids = new Set(masako.nodes.map((n) => n.qid));
check(
  "北条政子 hops=2: father-of-children 頼朝 (Q242800) kept",
  mQids.has("Q242800"),
);

console.log(
  failures === 0
    ? "\nCOMPETING-FATHER OK: filter drops the disputed father's branch and nothing else."
    : `\nCOMPETING-FATHER FAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
