// Cytoscape/dagre rendering config for the genealogy chart, shared by the live
// GraphPane renderer and the offline dump-layout debug script so the two can't
// drift. These are renderer constants (pixels, stylesheet, dagre options) and so
// live here, NOT in the pure lib/layout domain, which carries no UI geometry.
import type cytoscape from "cytoscape";
import type { Core } from "cytoscape";
import type * as cytoscapeDagre from "cytoscape-dagre";

export const NODE_SIZE = 16;
const NODE_SEP = 30; // internal: only feeds ROW and runEgoLayout's nodeSep
export const ROW = NODE_SEP + NODE_SIZE;
export const RANK_SEP = 220; // leaves room for a name between generation columns
export const SPOUSE_GUTTER = 70; // < RANK_SEP: stays in the node-free inter-column gutter

// Genealogy-chart styling: PARENT_OF is drawn as a rightward right-angle (taxi)
// line with an arrow — the tree spine flows left→right; SPOUSE_OF is a straight
// link joining a couple. Sibling edges are never emitted (siblings share a parent).
export const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "#64748b",
      label: "data(label)",
      "font-size": "10px",
      color: "#0f172a",
      "text-outline-width": 2,
      "text-outline-color": "#f8fafc",
      // Left-to-right tree with horizontal labels: put the name to the right of
      // each node so vertically-stacked siblings' labels don't collide.
      "text-valign": "center",
      "text-halign": "right",
      "text-margin-x": 4,
      width: NODE_SIZE,
      height: NODE_SIZE,
    },
  },
  {
    // Emphasis is colour + bold label only, never size: dagre sizes a rank's row
    // pitch by node bounds, so a larger focus node would push its own row off the
    // uniform sibling ladder (the label is excluded from layout, so font is safe).
    // `focus=1` marks the path-view endpoints; `.current` is the ego view's read
    // target (last fired) — both get the same red emphasis.
    selector: "node[focus = 1], node.current",
    style: {
      "background-color": "#dc2626",
      "font-size": "13px",
      "font-weight": "bold",
      "z-index": 10,
    },
  },
  {
    // The keyboard cursor in the ego view: a blue ring that moves with hjkl/arrows
    // and carries no side effect until Enter fires it. Drawn as a border so it can
    // coexist with `.current` red (cursor and current start on the same node).
    selector: "node.cursor",
    style: {
      "border-width": 3,
      "border-color": "#2563eb",
      "border-opacity": 1,
    },
  },
  {
    // Invisible anchor at a couple's midpoint; the descent line sprouts from it.
    // Drawn as a zero-size, click-through dot so its child edges still render
    // while the node itself shows nothing and isn't selectable.
    selector: "node[junction = 1]",
    style: { width: 1, height: 1, "background-opacity": 0, events: "no" },
  },
  {
    selector: "edge",
    style: { width: 1.5, "curve-style": "bezier", "line-color": "#cbd5e1" },
  },
  {
    // All parent→child relations flow as a rightward right-angle (taxi) line with an
    // arrowhead; only the colour (and the adoptive double-line) differ — see the
    // type-specific blocks below. Single-sourced so blood, adoption and the
    // midpoint-rooted DESCENT lines can't route apart. DESCENT is the synthetic
    // junction→child line (a distinct type so it never aliases a real person edge,
    // e.g. in the dagre layout query); it is styled identically to PARENT_OF below.
    selector:
      'edge[type = "PARENT_OF"], edge[type = "ADOPTIVE_PARENT_OF"], edge[type = "DESCENT"]',
    style: {
      "target-arrow-shape": "triangle",
      "curve-style": "taxi",
      "taxi-direction": "rightward",
      "taxi-turn": "50%",
    },
  },
  {
    selector: 'edge[type = "PARENT_OF"], edge[type = "DESCENT"]',
    style: { "line-color": "#475569", "target-arrow-color": "#475569" },
  },
  {
    selector: 'edge[type = "SPOUSE_OF"]',
    style: { "line-color": "#db2777", "curve-style": "straight" },
  },
  {
    // Adoption is a parent→child relation (same taxi routing as blood, above), but
    // drawn as a double line in a distinct green to mark it as non-blood. cytoscape
    // has no `line-style: double` for edges, so the doubling is faked with line-outline:
    // a background-coloured core line inside a thin green outline reads as two parallel
    // green strokes.
    selector: 'edge[type = "ADOPTIVE_PARENT_OF"]',
    style: {
      // width = the dark (background-coloured) gap; the green outline draws the two
      // parallel strokes on either side. A thin stroke + moderate gap reads as two
      // crisp parallel lines rather than one thick band.
      width: 4,
      "line-color": "#18181b",
      "line-outline-width": 1,
      "line-outline-color": "#22c55e",
      "target-arrow-color": "#22c55e",
    },
  },
  {
    // Mother→child edges fed to dagre only to co-rank couples (see layoutOnlyEdges).
    // `visibility: hidden` keeps them in the layout pass while not drawing them;
    // `display: none` would exclude them from layout and defeat the purpose.
    selector: 'edge[type = "LAYOUT"]',
    style: { visibility: "hidden" },
  },
];

// Flow left→right so each generation is a column and siblings stack vertically —
// horizontal labels then sit to the right without colliding. Typed via the dagre
// extension's options so a mistyped key is caught.
export function dagreLR(
  extra: Partial<cytoscapeDagre.DagreLayoutOptions> = {},
): cytoscapeDagre.DagreLayoutOptions {
  return { name: "dagre", rankDir: "LR", animate: false, ...extra };
}

// Lay out the ego graph on the descent edges only (drawn father→child plus the
// hidden mother→child LAYOUT edges that co-rank couples, plus adoptions). Spouse
// and sibling edges are excluded from ranking. fit:false: a prolific line is
// genuinely tall, so the caller opens at a readable zoom on the focus instead of
// fitting it to the pane.
export function runEgoLayout(cy: Core): void {
  cy.nodes()
    .union(
      cy.edges(
        '[type = "PARENT_OF"], [type = "LAYOUT"], [type = "ADOPTIVE_PARENT_OF"]',
      ),
    )
    .layout(dagreLR({ nodeSep: NODE_SEP, rankSep: RANK_SEP, fit: false }))
    .run();
}
