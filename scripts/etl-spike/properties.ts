// Wikidata property IDs used across the ETL sweeps. Naming carries the meaning
// once, so SPARQL templates interpolate the constant (`wdt:${FATHER}`) instead of
// a bare `P22` glossed in a comment. Role VALUES (adoptive kinship) live in
// adoption-roles.ts; this is the property-ID side.

// Parent → child descent.
export const FATHER = "P22";
export const MOTHER = "P25";
export const CHILD = "P40";

// Symmetric family relations.
export const SPOUSE = "P26";
export const SIBLING = "P3373";

// Node attributes.
export const SEX = "P21";
export const CITIZENSHIP = "P27";
export const COUNTRY = "P17"; // country of a citizenship (CITIZENSHIP→COUNTRY path)
export const INSTANCE_OF = "P31";

// Reified kinship, carried as qualifiers on a statement.
export const RELATIVE = "P1038"; // generic "relative", the non-parent adoptive source
export const KINSHIP_ROLE = "P1039"; // object's kinship to subject (養父/養子/…)
export const SOURCING_CIRCUMSTANCES = "P1480"; // e.g. "presumed", for disputed claims
