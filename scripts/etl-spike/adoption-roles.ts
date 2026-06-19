// P1039 (kinship to subject) values that mark an ADOPTIVE parent/child relation.
// Shared so the two stages can never drift on what counts as adoption:
//  - fetch-adoptions.ts CAPTURES these as ADOPTIVE_PARENT_OF edges.
//  - fetch.ts EXCLUDES them from the biological PARENT_OF spine.
// (A plain module, not an import from fetch-adoptions.ts, whose top-level
// `await main()` would run as a side effect of importing it.)

// The object is the subject's adoptive PARENT.
export const PARENT_ROLE = new Set([
  "Q61740757", // 養父
  "Q61740758", // 養母
]);

// The object is the subject's adoptive CHILD.
export const CHILD_ROLE = [
  "Q25858158", // 養子 (legal, any gender)
  "Q20746725", // 養男子 (legal, male)
  "Q20746728", // 養女 (legal, female)
  "Q110267632", // adoptee
  "Q11572068", // 猶子 (nominal adoption)
  "Q6933584", // 婿養子 (adopted son-in-law)
];

export const KINSHIP = [...PARENT_ROLE, ...CHILD_ROLE];
