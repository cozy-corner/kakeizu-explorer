// Shared E-stage sweeps (issue #44). Every attribute we persist is fetched here,
// so fetch.ts and traverse.ts fill raw-*.json the same way as they discover
// nodes/edges. This folds three former per-stage re-queries of the same nodes
// (label inline in fetch.ts, P21 in add-sex.ts, P27 in traverse.ts+filter-foreign.ts)
// into one node sweep, and the two former reified parent passes (fetch.ts's
// EXCLUDE_ADOPTIVE + fetch-adoptions.ts) into one edge sweep. It only fetches;
// deciding which edges exist stays with the callers' truthy queries.

import { KINSHIP, PARENT_ROLE } from "./adoption-roles";
import { chunk, qid, sparql, sparqlValues } from "./wdqs";
import type { Rank, RawEdge, RawNode, RawParentEdge, Sex } from "./raw";

const NODE_BATCH = 400;
const EDGE_BATCH = 120; // reified form is heavier — keep the VALUES list small

const SEX_QID: Record<string, Sex> = {
  Q6581097: "male",
  Q6581072: "female",
};

const RANK_URI: Record<string, Rank> = {
  "http://wikiba.se/ontology#PreferredRank": "preferred",
  "http://wikiba.se/ontology#NormalRank": "normal",
  "http://wikiba.se/ontology#DeprecatedRank": "deprecated",
};

const pushUniq = (arr: string[], v: string) => {
  if (!arr.includes(v)) arr.push(v);
};

// label (ja,en) + sex (P21) + nationalities (P27) + nationality countries
// (P27→P17) for a set of qids. Same values the old separate stages fetched, now
// captured once. Nodes with no label fall back to their qid (matches the old
// `label ?? id` / `l || q`); nodes with no P27 get empty arrays (kept as bridge
// relatives by foreign-pruning, which only removes nodes that HAVE a nationality).
export async function fetchNodeAttrs(
  qids: string[],
): Promise<Map<string, RawNode>> {
  const out = new Map<string, RawNode>();
  const ensure = (uri: string): RawNode => {
    const q = qid(uri);
    let n = out.get(q);
    if (!n) {
      n = { qid: q, label: q, nationalities: [], nationalityCountries: [] };
      out.set(q, n);
    }
    return n;
  };
  for (const b of chunk(qids, NODE_BATCH)) {
    const values = sparqlValues(b);
    for (const r of await sparql(
      `SELECT ?item ?itemLabel WHERE { VALUES ?item { ${values} }
       SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". } }`,
    )) {
      const n = ensure(r.item!.value);
      n.label = r.itemLabel?.value || n.qid;
    }
    for (const r of await sparql(
      `SELECT ?item ?sex WHERE { VALUES ?item { ${values} } ?item wdt:P21 ?sex. }`,
    )) {
      const n = ensure(r.item!.value);
      // First P21 wins; non male/female (intersex, trans, …) → "other".
      if (n.sex === undefined) n.sex = SEX_QID[qid(r.sex!.value)] ?? "other";
    }
    for (const r of await sparql(
      `SELECT ?item ?nat WHERE { VALUES ?item { ${values} } ?item wdt:P27 ?nat. }`,
    )) {
      pushUniq(ensure(r.item!.value).nationalities, qid(r.nat!.value));
    }
    for (const r of await sparql(
      `SELECT ?item ?c WHERE { VALUES ?item { ${values} } ?item wdt:P27/wdt:P17 ?c. }`,
    )) {
      pushUniq(ensure(r.item!.value).nationalityCountries, qid(r.c!.value));
    }
  }
  return out;
}

// One reified parent statement (a single P22/P25/P40 claim), grouped by its
// statement node. `side` records who asserted it: child-side = the child's
// P22/P25 → parent; parent-side = the parent's P40 → child.
interface ParentStatement {
  child: string;
  parent: string;
  side: "child" | "parent";
  rank: Rank;
  roles: string[]; // P1039
  sourcing: string[]; // P1480
}

// Reified P22/P25/P40 statements for the given subjects, in ONE pass carrying
// rank + P1039 + P1480. `wikibase:rank` sits INSIDE each UNION branch so ?st is
// bound to the subject's statement, not scanned across all statements (an
// unbound ?st 504s — see memory wdqs-rank-inside-union). This replaces both the
// EXCLUDE_ADOPTIVE subquery and fetch-adoptions.ts's separate reified fetch.
async function fetchParentStatements(
  subjects: string[],
): Promise<Map<string, ParentStatement>> {
  const byStatement = new Map<string, ParentStatement>();
  for (const b of chunk(subjects, EDGE_BATCH)) {
    const rows = await sparql(`
      SELECT ?st ?child ?parent ?side ?rank ?role ?circ WHERE {
        VALUES ?s { ${sparqlValues(b)} }
        {
          { ?s p:P22 ?st. ?st ps:P22 ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?child) BIND(?o AS ?parent) BIND("child" AS ?side) }
          UNION
          { ?s p:P25 ?st. ?st ps:P25 ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?child) BIND(?o AS ?parent) BIND("child" AS ?side) }
          UNION
          { ?s p:P40 ?st. ?st ps:P40 ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?parent) BIND(?o AS ?child) BIND("parent" AS ?side) }
        }
        OPTIONAL { ?st pq:P1039 ?role. }
        OPTIONAL { ?st pq:P1480 ?circ. }
      }`);
    for (const r of rows) {
      const child = qid(r.child!.value);
      const parent = qid(r.parent!.value);
      // "unknown value" snaks surface as blank-node IRIs, not Q-ids.
      if (!/^Q\d+$/.test(child) || !/^Q\d+$/.test(parent)) continue;
      const st = r.st!.value;
      let s = byStatement.get(st);
      if (!s) {
        s = {
          child,
          parent,
          side: r.side!.value as "child" | "parent",
          rank: RANK_URI[r.rank!.value] ?? "normal",
          roles: [],
          sourcing: [],
        };
        byStatement.set(st, s);
      }
      if (r.role) pushUniq(s.roles, qid(r.role.value));
      if (r.circ) pushUniq(s.sourcing, qid(r.circ.value));
    }
  }
  return byStatement;
}

// Annotate truthy parent→child edges with the reified attributes of their
// statements. Truthy decides which edges exist (unchanged); the statements only
// supply rank/role/sourcing. `role` is the first P1039 seen on either side's
// statement — matching how the old EXCLUDE_ADOPTIVE looked for P1039 across
// P22/P25 (child-side) and P40 (parent-side) alike.
export async function annotateParentEdges(
  edges: { from: string; to: string }[],
  subjects: string[],
): Promise<RawParentEdge[]> {
  const statements = await fetchParentStatements(subjects);
  const childSide = new Map<string, ParentStatement>();
  const parentSide = new Map<string, ParentStatement>();
  for (const s of statements.values()) {
    const key = `${s.parent}->${s.child}`;
    (s.side === "child" ? childSide : parentSide).set(key, s);
  }
  return edges.map(({ from, to }) => {
    const key = `${from}->${to}`;
    const c = childSide.get(key);
    const p = parentSide.get(key);
    // role/sourcing are drawn only from non-deprecated statements, so this
    // metadata can't disagree with the authoritative adoptive set (raw-adoptions,
    // which also drops DeprecatedRank). NOTE: the adoptive split uses that set,
    // not this `role` — this is per-edge annotation for later #43/presumed work.
    const live = [c, p].filter(
      (s): s is ParentStatement => !!s && s.rank !== "deprecated",
    );
    const roles = live.flatMap((s) => s.roles);
    const sourcing: string[] = [];
    for (const v of live.flatMap((s) => s.sourcing)) pushUniq(sourcing, v);
    return {
      from,
      to,
      childSideRank: c?.rank,
      parentSideRank: p?.rank,
      role: roles[0],
      sourcing,
    };
  });
}

// Every ADOPTIVE relation among `subjects`, oriented adoptiveParent→child. A
// verbatim port of the former fetch-adoptions.ts query: reified P1038/P22/P25/P40
// qualified by P1039 ∈ KINSHIP, non-deprecated. The `known.has(o)` in-graph
// filter moves to the local split (which keeps only edges between final nodes).
// `wikibase:rank` sits after the UNION because `pq:P1039 ?k` (VALUES ?k) already
// binds ?st to a small set — the 504 risk is only an unrestricted ?st.
export async function fetchAdoptiveEdges(
  subjects: string[],
): Promise<RawEdge[]> {
  const kinshipValues = sparqlValues(KINSHIP);
  const edges = new Set<string>(); // `from->to`, deduped
  for (const b of chunk(subjects, EDGE_BATCH)) {
    const rows = await sparql(`
      SELECT ?s ?o ?k WHERE {
        VALUES ?s { ${sparqlValues(b)} }
        VALUES ?k { ${kinshipValues} }
        {
          { ?s p:P1038 ?st. ?st ps:P1038 ?o. }
          UNION { ?s p:P22 ?st. ?st ps:P22 ?o. }
          UNION { ?s p:P25 ?st. ?st ps:P25 ?o. }
          UNION { ?s p:P40 ?st. ?st ps:P40 ?o. }
        }
        ?st pq:P1039 ?k.
        ?st wikibase:rank ?rank.
        FILTER(?rank != wikibase:DeprecatedRank)
      }`);
    for (const r of rows) {
      const s = qid(r.s!.value);
      const o = qid(r.o!.value);
      const k = qid(r.k!.value);
      if (s === o || !/^Q\d+$/.test(o)) continue;
      const [from, to] = PARENT_ROLE.has(k) ? [o, s] : [s, o];
      edges.add(`${from}->${to}`);
    }
  }
  return [...edges].map((e) => {
    const [from, to] = e.split("->");
    return { from, to };
  });
}
