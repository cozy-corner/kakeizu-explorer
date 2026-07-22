import { sparql, sparqlValues } from "./wdqs";

const ADOPTIVE_PARENT = "Q100";
const ADOPTIVE_CHILD = "Q101";

interface NodeAttrs {
  qid: string;
  label: string;
  nationalities: string[];
}

// Fetch every node attribute (qid, label, nationalities) in one pass so the
// local transforms never re-hit WDQS.
async function fetchNodeAttrs(ids: string[]): Promise<Map<string, NodeAttrs>> {
  const out = new Map<string, NodeAttrs>();
  const query = `SELECT ?q ?label WHERE {
    VALUES ?q { ${sparqlValues(ids)} }
    ?q rdfs:label ?label. FILTER(lang(?label) = "ja")
  }`;
  for (const b of await sparql(query)) {
    // build the attrs record
    const qid = b.q!.value;
    out.set(qid, { qid, label: b.label!.value, nationalities: [] });
  }
  return out;
}

// Parent edges from P22 (father) / P25 (mother) / P40 (child). A child with two
// recorded fathers is kept as TWO edges rather than one, because multiple P22
// usually means 諸説 (disputed parentage) — picking one fabricates an unsourced
// bloodline.
async function fetchParentEdges(
  ids: string[],
): Promise<{ from: string; to: string }[]> {
  // P22 = father, P25 = mother, P40 = child
  const query = `SELECT ?p ?c WHERE {
    VALUES ?c { ${sparqlValues(ids)} }
    { ?c wdt:P22 ?p } UNION { ?c wdt:P25 ?p } UNION { ?p wdt:P40 ?c }
  }`;
  const edges: { from: string; to: string }[] = [];
  for (const b of await sparql(query)) {
    // from = parent, to = child
    edges.push({ from: b.p!.value, to: b.c!.value });
  }
  return edges;
}

function isAdoptive(role: string): boolean {
  // role is ADOPTIVE_PARENT or ADOPTIVE_CHILD
  return role === ADOPTIVE_PARENT || role === ADOPTIVE_CHILD;
}
