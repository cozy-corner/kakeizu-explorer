// Shared E-stage sweeps: every persisted attribute is fetched here, in one node
// sweep and one edge sweep. It only fetches; deciding which edges exist stays
// with the callers' truthy queries.

import { KINSHIP, PARENT_ROLE } from "./adoption-roles";
import {
  CHILD,
  CITIZENSHIP,
  COUNTRY,
  FATHER,
  KINSHIP_ROLE,
  MOTHER,
  RELATIVE,
  SEX,
  SOURCING_CIRCUMSTANCES,
} from "./properties";
import { chunk, qid, sparql, sparqlValues } from "./wdqs";
import type { Rank, RawAdoptiveEdge, RawNode, RawParentEdge, Sex } from "./raw";

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

const RANK_ORDER: Record<Rank, number> = {
  preferred: 2,
  normal: 1,
  deprecated: 0,
};

const KINSHIP_SET = new Set(KINSHIP);

const pushUniq = (arr: string[], v: string) => {
  if (!arr.includes(v)) arr.push(v);
};

// label (ja,en) + sex + nationalities + nationality countries (citizenship →
// country) + ja.wikipedia title (sitelink schema:name) for a set of qids.
// Nodes with no label fall back to their qid; nodes with no citizenship get empty arrays
// (kept as bridge relatives by foreign-pruning, which only removes nodes that
// HAVE a nationality); nodes with no ja.wikipedia article get no wikipediaTitle.
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
  // Rows are folded in the fixed order below so the "first wins" merges (sex,
  // wikipediaTitle) stay deterministic regardless of completion order.
  await Promise.all(
    chunk(qids, NODE_BATCH).map(async (b) => {
      const values = sparqlValues(b);
      const [labels, sexes, nats, countries, titles] = await Promise.all([
        // Keep the exact whitespace of every query string below: the result
        // cache is keyed by sha1(query), so re-indenting invalidates it.
        sparql(
          `SELECT ?item ?itemLabel WHERE { VALUES ?item { ${values} }
       SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". } }`,
        ),
        sparql(
          `SELECT ?item ?sex WHERE { VALUES ?item { ${values} } ?item wdt:${SEX} ?sex. }`,
        ),
        sparql(
          `SELECT ?item ?nat WHERE { VALUES ?item { ${values} } ?item wdt:${CITIZENSHIP} ?nat. }`,
        ),
        sparql(
          `SELECT ?item ?c WHERE { VALUES ?item { ${values} } ?item wdt:${CITIZENSHIP}/wdt:${COUNTRY} ?c. }`,
        ),
        // schema:name on the ja.wikipedia sitelink is the canonical article title
        // (only present for items that have such an article).
        sparql(
          `SELECT ?item ?title WHERE { VALUES ?item { ${values} }
       ?art schema:about ?item; schema:isPartOf <https://ja.wikipedia.org/>;
            schema:name ?title. }`,
        ),
      ]);
      for (const r of labels) {
        const n = ensure(r.item!.value);
        n.label = r.itemLabel?.value || n.qid;
      }
      for (const r of sexes) {
        const n = ensure(r.item!.value);
        if (n.sex === undefined) n.sex = SEX_QID[qid(r.sex!.value)] ?? "other";
      }
      for (const r of nats) {
        pushUniq(ensure(r.item!.value).nationalities, qid(r.nat!.value));
      }
      for (const r of countries) {
        pushUniq(ensure(r.item!.value).nationalityCountries, qid(r.c!.value));
      }
      for (const r of titles) {
        const n = ensure(r.item!.value);
        if (n.wikipediaTitle === undefined) n.wikipediaTitle = r.title!.value;
      }
    }),
  );
  return out;
}

// One reified parent statement (a single father/mother/child claim), grouped by
// its statement node. `side` records who asserted it: child-side = the child's
// FATHER/MOTHER → parent; parent-side = the parent's CHILD → child.
interface ParentStatement {
  child: string;
  parent: string;
  side: "child" | "parent";
  rank: Rank;
  roles: string[]; // KINSHIP_ROLE
  sourcing: string[]; // SOURCING_CIRCUMSTANCES
}

// Reified father/mother/child statements for the given subjects, in ONE pass
// carrying rank + KINSHIP_ROLE + SOURCING_CIRCUMSTANCES. `wikibase:rank` sits
// INSIDE each UNION branch so ?st is bound to the subject's statement, not
// scanned across all statements (an unbound ?st 504s).
async function fetchParentStatements(
  subjects: string[],
): Promise<ParentStatement[]> {
  const byStatement = new Map<string, ParentStatement>();
  // Fold in batch order to keep byStatement deterministic regardless of
  // completion order.
  const rowsByBatch = await Promise.all(
    chunk(subjects, EDGE_BATCH).map((b) =>
      sparql(`
      SELECT ?st ?child ?parent ?side ?rank ?role ?circ WHERE {
        VALUES ?s { ${sparqlValues(b)} }
        {
          { ?s p:${FATHER} ?st. ?st ps:${FATHER} ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?child) BIND(?o AS ?parent) BIND("child" AS ?side) }
          UNION
          { ?s p:${MOTHER} ?st. ?st ps:${MOTHER} ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?child) BIND(?o AS ?parent) BIND("child" AS ?side) }
          UNION
          { ?s p:${CHILD} ?st. ?st ps:${CHILD} ?o. ?st wikibase:rank ?rank.
            BIND(?s AS ?parent) BIND(?o AS ?child) BIND("parent" AS ?side) }
        }
        OPTIONAL { ?st pq:${KINSHIP_ROLE} ?role. }
        OPTIONAL { ?st pq:${SOURCING_CIRCUMSTANCES} ?circ. }
      }`),
    ),
  );
  for (const rows of rowsByBatch) {
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
  return [...byStatement.values()];
}

// Orient one adoptive relation to adoptiveParent→child and return its `from->to`
// key (null for a self-loop). KINSHIP_ROLE gives the OBJECT's kinship TO the SUBJECT, so
// 養父/養母 (PARENT_ROLE) ⇒ the object is the adoptive parent (obj→subj); every
// other kinship ⇒ the object is the adoptive child (subj→obj).
function adoptiveKey(subj: string, obj: string, role: string): string | null {
  const [from, to] = PARENT_ROLE.has(role) ? [obj, subj] : [subj, obj];
  return from === to ? null : `${from}->${to}`;
}

// Split truthy parent→child edges into biological + adoptive and annotate the
// biological ones, all from ONE reified father/mother/child sweep. Adoption
// recorded via RELATIVE (generic "relative") can't come from parent statements,
// so it's the lone extra sweep.
export async function fetchParentAndAdoptions(
  subjects: string[],
  truthyEdges: { from: string; to: string }[],
): Promise<{ parent: RawParentEdge[]; adoptions: RawAdoptiveEdge[] }> {
  const [statements, p1038] = await Promise.all([
    fetchParentStatements(subjects),
    fetchP1038Adoptions(subjects),
  ]);
  const adoptionKeys = new Set<string>();
  for (const e of adoptiveFromStatements(statements)) adoptionKeys.add(e);
  for (const e of p1038) adoptionKeys.add(e);
  return {
    parent: annotateFromStatements(truthyEdges, statements),
    adoptions: [...adoptionKeys].map((e) => {
      const [from, to] = e.split("->");
      return { from, to };
    }),
  };
}

// Attach each truthy edge's reified rank/role/sourcing; truthy decides which
// edges exist, statements only supply attributes. role/sourcing come only from
// non-deprecated statements so this metadata can't disagree with the
// authoritative adoptive set.
function annotateFromStatements(
  edges: { from: string; to: string }[],
  statements: ParentStatement[],
): RawParentEdge[] {
  const childSide = new Map<string, ParentStatement>();
  const parentSide = new Map<string, ParentStatement>();
  // On several same-side statements for a pair, keep the best-rank one so the
  // recorded *SideRank matches the truthy (best-rank) edge and doesn't flip with
  // SPARQL result order.
  const keepBest = (
    m: Map<string, ParentStatement>,
    key: string,
    s: ParentStatement,
  ) => {
    const cur = m.get(key);
    if (!cur || RANK_ORDER[s.rank] > RANK_ORDER[cur.rank]) m.set(key, s);
  };
  for (const s of statements) {
    const key = `${s.parent}->${s.child}`;
    keepBest(s.side === "child" ? childSide : parentSide, key, s);
  }
  return edges.map(({ from, to }) => {
    const key = `${from}->${to}`;
    const c = childSide.get(key);
    const p = parentSide.get(key);
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

// Adoptive edges recorded inside the father/mother/child statements we already
// fetched (KINSHIP_ROLE ∈ KINSHIP, non-deprecated), oriented adoptiveParent→child by role.
// Derived in-memory; no extra WDQS. Returns `from->to` keys.
function adoptiveFromStatements(statements: ParentStatement[]): string[] {
  const out: string[] = [];
  for (const s of statements) {
    if (s.rank === "deprecated") continue;
    // Recover the reified subject/object: FATHER/MOTHER assert on the child, CHILD
    // on the parent.
    const subj = s.side === "child" ? s.child : s.parent;
    const obj = s.side === "child" ? s.parent : s.child;
    for (const k of s.roles) {
      if (!KINSHIP_SET.has(k)) continue;
      const key = adoptiveKey(subj, obj, k);
      if (key) out.push(key);
    }
  }
  return out;
}

// Adoptions recorded via RELATIVE (generic "relative" + KINSHIP_ROLE) — the only
// adoptive source not reachable from the parent statements, so the lone extra sweep.
// `wikibase:rank` sits after the pattern because the KINSHIP_ROLE qualifier (VALUES
// ?k) binds ?st to a small set — the 504 risk is only an unrestricted ?st. Returns keys.
async function fetchP1038Adoptions(subjects: string[]): Promise<string[]> {
  const kinshipValues = sparqlValues(KINSHIP);
  const out: string[] = [];
  const rowsByBatch = await Promise.all(
    chunk(subjects, EDGE_BATCH).map((b) =>
      sparql(`
      SELECT ?s ?o ?k WHERE {
        VALUES ?s { ${sparqlValues(b)} }
        VALUES ?k { ${kinshipValues} }
        ?s p:${RELATIVE} ?st. ?st ps:${RELATIVE} ?o.
        ?st pq:${KINSHIP_ROLE} ?k.
        ?st wikibase:rank ?rank.
        FILTER(?rank != wikibase:DeprecatedRank)
      }`),
    ),
  );
  for (const rows of rowsByBatch) {
    for (const r of rows) {
      const s = qid(r.s!.value);
      const o = qid(r.o!.value);
      const k = qid(r.k!.value);
      if (!/^Q\d+$/.test(o)) continue;
      const key = adoptiveKey(s, o, k);
      if (key) out.push(key);
    }
  }
  return out;
}
