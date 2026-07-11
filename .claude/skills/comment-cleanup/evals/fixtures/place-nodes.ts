import type { PersonId } from "./graph";

interface Placed {
  col: number;
  order: number;
  x: number;
  y: number;
}

// Capture the x of the first node seen in each column.
// dagre's per-rank x is not guaranteed to be a fixed multiple, so we can't just
// compute col * SPACING — we have to read back what dagre actually assigned.
export function placeNodes(
  nodes: Array<{
    id: PersonId;
    col: number;
    order: number;
    x: number;
    y: number;
  }>,
): Map<PersonId, Placed> {
  const colX = new Map<number, number>();
  const place = new Map<PersonId, Placed>();

  // loop over every node
  for (const n of nodes) {
    // x is uniform within a column
    if (!colX.has(n.col)) colX.set(n.col, n.x);

    // set the placed record
    place.set(n.id, {
      col: n.col,
      order: n.order,
      x: colX.get(n.col)!,
      y: n.y,
    });
  }

  return place;
}

export function centerCouple(fp: Placed, mp: Placed, cp: Placed): number {
  // not a co-located couple
  if (fp.col !== mp.col) return cp.order;

  // live midpoint
  const dOrder = (fp.order + mp.order) / 2 - cp.order;

  // increment by half a row
  return cp.order + dOrder / 2;
}
