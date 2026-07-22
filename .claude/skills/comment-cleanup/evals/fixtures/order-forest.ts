import type { PersonId } from "./graph";

type Sub = { top: Map<number, number>; bottom: Map<number, number> };

// Pixel → structural at the layout boundary. round(x) happens here, once, and the
// per-column actual x is captured in colX so project reproduces dagre's column
// positions exactly rather than assuming a uniform stride — dagre's per-rank x is
// not guaranteed to be a fixed multiple.
export function readColX(
  nodes: Array<{ col: number; x: number }>,
): Map<number, number> {
  const colX = new Map<number, number>();
  for (const n of nodes) if (!colX.has(n.col)) colX.set(n.col, n.x);
  return colX;
}

// Stack sibling subtrees top-to-bottom, each shifted just enough to clear the running
// contour of the ones above by one row in every shared column. Direct siblings always
// share their own column, so that column pins the ordering; deeper generations extend
// the contour rightward and keep cousin subtrees from overlapping. Returns the merged
// contour after every subtree has been placed.
export function stackSubtrees(subs: Sub[]): {
  top: Map<number, number>;
  bottom: Map<number, number>;
} {
  const top = new Map<number, number>();
  const bottom = new Map<number, number>();
  for (const sub of subs) {
    // Clear the running contour by one row in every shared column; an unshared column
    // contributes -Infinity so it never binds, and the 0 floor keeps a subtree from
    // sliding up.
    const shift = Math.max(
      0,
      ...[...sub.top].map(([col, t]) => {
        const b = bottom.get(col);
        return b === undefined ? -Infinity : b + 1 - t;
      }),
    );
    for (const [col, t] of sub.top)
      top.set(col, Math.min(top.get(col) ?? Infinity, t + shift));
    for (const [col, b] of sub.bottom)
      bottom.set(col, Math.max(bottom.get(col) ?? -Infinity, b + shift));
  }
  return { top, bottom };
}

// Caller must pass subtrees already sorted top-to-bottom by row — orderDescentForest
// guarantees it upstream, and stacking below relies on that order. Nothing here checks
// it, so an unsorted input would silently produce overlapping rows.
export function stackSorted(subs: Sub[]): {
  top: Map<number, number>;
  bottom: Map<number, number>;
} {
  return stackSubtrees(subs);
}

// x from the column's captured value, y back to order×row. Every col a pass emits is
// always a colX key, so the lookup below can never miss.
export function projectOne(
  col: number,
  order: number,
  colX: Map<number, number>,
  row: number,
): { x: number; y: number } {
  const x = colX.get(col);
  // Throw rather than emit an x: a TS `!` is erased at runtime and would yield
  // x: undefined; falling back to col would project the bucket index as a pixel —
  // both hide a column-bookkeeping bug as a far-left ghost.
  if (x === undefined)
    throw new Error(`projectOne: column ${col} not present in colX`);
  return { x, y: order * row };
}
