// Diagnostic (issue #16): the saved raw graph is already fully traversed, so a
// re-run discovers 0 new nodes and only exercises the edge-loop. To find the
// Amdahl fraction anyway, measure the per-batch UNIT cost of each WDQS stage on
// real QIDs — cold (WDQS_NOCACHE=1) — then combine with expected batch counts.
//
// Run: WDQS_NOCACHE=1 bun run scripts/etl-spike/bench-stages.ts

import { fetchNodeAttrs, fetchParentAndAdoptions } from "./attrs";
import { RAW_NODES, type RawNode, readRaw } from "./raw";
import { sparql, sparqlValues } from "./wdqs";

const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const r = await fn();
  console.log(
    `  ${label.padEnd(28)} ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );
  return r;
};

async function main() {
  const nodes = await readRaw<RawNode[]>(RAW_NODES);
  const qids = nodes.map((n) => n.qid);

  // Edge-loop unit: one 5-predicate query over EDGE_BATCH=120 subjects.
  const edge = qids.slice(0, 120);
  await time("edge-loop (120 subj) ×1", () =>
    sparql(`
      SELECT ?s ?p ?o WHERE {
        VALUES ?s { ${sparqlValues(edge)} }
        VALUES ?p { wdt:P22 wdt:P25 wdt:P40 wdt:P26 wdt:P3373 }
        ?s ?p ?o. }`),
  );

  // attrs unit: fetchNodeAttrs over NODE_BATCH=400 subjects (its 5 serial queries).
  const attrs = qids.slice(0, 400);
  await time("attrs (400 subj, 5 queries)", () => fetchNodeAttrs(attrs));

  // final-sweep unit: reified P22/P25/P40 + P1038 over EDGE_BATCH=120 subjects.
  await time("final-sweep (120 subj)", () => fetchParentAndAdoptions(edge, []));
}

await main();
