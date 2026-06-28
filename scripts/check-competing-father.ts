// Regression guard for the competing-father filter in the neighbors API
// (app/api/person/[id]/neighbors/route.ts). The rule lives in a Cypher string,
// so it can only be exercised against the live DB — same constraint as
// layout-parity.ts. Asserts on real ego graphs:
//   - 頼朝 (paternal ego): 大友能直's competing father 近藤能成 is dropped, while
//     the mother 利根局 and the child 大友能直 stay, and nothing floats.
//   - 北条政子 (female ego): her children's father 頼朝 is NOT dropped.
//
// Run with the dev server up: bun run scripts/check-competing-father.ts
import type { Graph } from "../lib/graph";

async function ego(qid: string): Promise<Graph> {
  const res = await fetch(
    `http://localhost:3000/api/person/${encodeURIComponent(qid)}/neighbors?hops=2`,
  );
  if (!res.ok) {
    throw new Error(`ego(${qid}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Graph;
}

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
}

// 頼朝 — the competing-father case the filter targets.
const yoritomo = await ego("Q242800");
const yQids = new Set(yoritomo.nodes.map((n) => n.qid));
check("頼朝: 近藤能成 (Q106592356) dropped", !yQids.has("Q106592356"));
check("頼朝: mother 利根局 (Q106595994) kept", yQids.has("Q106595994"));
check("頼朝: child 大友能直 (Q11433255) kept", yQids.has("Q11433255"));

// No node may be left without an incident edge (a dropped node must take its
// dangling edges with it).
const connected = new Set<string>();
for (const e of yoritomo.edges) {
  connected.add(e.source);
  connected.add(e.target);
}
const floating = yoritomo.nodes.filter(
  (n) => n.qid !== "Q242800" && !connected.has(n.qid),
);
check(
  `頼朝: no floating node${floating.length ? ` (${floating.map((n) => n.qid).join(", ")})` : ""}`,
  floating.length === 0,
);

// 北条政子 — a female ego must keep the father of her children (the filter must
// not fire for a non-paternal focus).
const masako = await ego("Q463961");
const mQids = new Set(masako.nodes.map((n) => n.qid));
check("北条政子: father-of-children 頼朝 (Q242800) kept", mQids.has("Q242800"));

console.log(
  failures === 0
    ? "\nCOMPETING-FATHER OK: filter drops the disputed father and nothing else."
    : `\nCOMPETING-FATHER FAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
