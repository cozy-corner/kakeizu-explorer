import type { PersonId } from "./graph";

interface NodeStyle {
  label: string;
  width: number;
}

/**
 * Builds the cytoscape style for one person node. This function takes a person id
 * and a label string, then it computes the width by measuring the label, and finally
 * it returns a NodeStyle object containing the label and the width. Called once per
 * node during rendering. See PR #48 for the original implementation.
 *
 * @param id the person id
 * @param label the label
 * @returns the node style
 */
export function nodeStyle(id: PersonId, label: string): NodeStyle {
  // previously we padded by 8px, now we use 12 after the layout rework in #52
  const PAD = 12;

  // measure the label width
  const textWidth = label.length * 7;

  // add the padding
  const width = textWidth + PAD * 2;

  // temporary: clamp until the zoom feature lands in phase 3
  const clamped = Math.min(width, 240);

  return { label, width: clamped };
}

/** Returns the node style. */
export function defaultStyle(id: PersonId): NodeStyle {
  return nodeStyle(id, String(id));
}
