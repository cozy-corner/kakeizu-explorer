// Cytoscape/dagre rendering constants (pixels, stylesheet, dagre options) for the
// genealogy chart, shared by the live GraphPane renderer and the offline dump-layout
// script so the two can't drift. Kept out of pure lib/layout, which carries no UI geometry.
import type cytoscape from "cytoscape";
import type { Core } from "cytoscape";
import type * as cytoscapeDagre from "cytoscape-dagre";

export const NODE_SIZE = 16;
const NODE_SEP = 30;
export const ROW = NODE_SEP + NODE_SIZE;
export const RANK_SEP = 220; // leaves room for a name between generation columns
export const SPOUSE_GUTTER = 70; // < RANK_SEP: stays in the node-free inter-column gutter

// 和 palette for the graph. Literals (not CSS vars) because the offline dump-layout
// script consumes this stylesheet with no DOM to resolve vars against. Sex colours
// (藍/紅) live inline below, belonging to the sex convention rather than this theme.
const WA = {
  washi: "#f5f0e6", // 生成り — page ground; label outline + adoption core gap
  ink: "#1c1a17", // 墨 — labels
  rikyu: "#6b6357", // 利休鼠 — unknown-sex node
  ai: "#223a70", // 藍 — keyboard cursor ring
  shu: "#c1352b", // 朱 — focus/current
  enji: "#9e3d4f", // 臙脂 — spouse line
  kincha: "#916008", // 金茶 — adoptive (dashed) line
  suminezu: "#5a5450", // 墨鼠 — descent/parent line
  edge: "#c9bda3", // faint default edge
} as const;

// Genealogy-chart styling. Sibling edges are never emitted (siblings share a parent).
export const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      // Unknown-sex fallback (a P21-less person). A junction inherits it too but is
      // invisible, so the diamond never shows.
      "background-color": WA.rikyu,
      shape: "diamond",
      // `data(label)` stays the pure name (used by the article pane / focus callbacks);
      // the ego view's `disp` appends the degree badge. Every drawable node must carry
      // `disp` or its label vanishes.
      label: "data(disp)",
      "font-size": "10px",
      color: WA.ink,
      "text-outline-width": 2,
      "text-outline-color": WA.washi, // matches the page ground so labels read on any node
      // Name sits to the right so vertically-stacked siblings' labels don't collide.
      "text-valign": "center",
      "text-halign": "right",
      "text-margin-x": 4,
      width: NODE_SIZE,
      height: NODE_SIZE,
    },
  },
  {
    // Sex distinction (shape + colour), leaning on the Japanese convention of
    // indigo for men and crimson for women. Shape carries the distinction on its
    // own so the focus red (below, which overrides fill) never erases it, and it
    // survives for colour-blind readers. Placed before the focus block so that
    // block's red fill wins on the focused node.
    selector: 'node[sex = "male"]',
    style: { shape: "rectangle", "background-color": "#1e3a8a" },
  },
  {
    selector: 'node[sex = "female"]',
    style: { shape: "ellipse", "background-color": "#f43f5e" },
  },
  {
    // Emphasis is colour + bold label only, never size: dagre sizes a rank's row
    // pitch by node bounds, so a larger focus node would push its own row off the
    // uniform sibling ladder (the label is excluded from layout, so font is safe).
    // `focus=1` marks the path-view endpoints; `.current` is the ego view's read
    // target (last fired) — both get the same red emphasis.
    selector: "node[focus = 1], node.current",
    style: {
      "background-color": WA.shu,
      "font-size": "13px",
      "font-weight": "bold",
      "z-index": 10,
    },
  },
  {
    // The ego view's keyboard cursor. Drawn as a border so it can coexist with
    // `.current` red (cursor and current start on the same node).
    selector: "node.cursor",
    style: {
      "border-width": 3,
      "border-color": WA.ai,
      "border-opacity": 1,
    },
  },
  {
    // Invisible anchor at a couple's midpoint that the descent line sprouts from —
    // kept as a zero-size, click-through dot so its child edges still route.
    selector: "node[junction = 1]",
    style: { width: 1, height: 1, "background-opacity": 0, events: "no" },
  },
  {
    selector: "edge",
    style: { width: 1.5, "curve-style": "bezier", "line-color": WA.edge },
  },
  {
    // Single selector for all parent→child taxi routing so blood, adoption and the
    // midpoint-rooted DESCENT lines can't drift apart; colour and the adoptive
    // dashing differ in the blocks below. DESCENT is the synthetic junction→child
    // line, a distinct type so it never aliases a real person edge (e.g. in the
    // dagre layout query).
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
    style: { "line-color": WA.suminezu, "target-arrow-color": WA.suminezu },
  },
  {
    selector: 'edge[type = "SPOUSE_OF"]',
    style: { "line-color": WA.enji, "curve-style": "straight" },
  },
  {
    // Adoption is a parent→child relation (same taxi routing as blood, above),
    // drawn dashed so the non-blood tie reads by line FORM, not colour alone —
    // legible regardless of palette contrast or colour vision. 金茶 only reinforces.
    selector: 'edge[type = "ADOPTIVE_PARENT_OF"]',
    style: {
      width: 1.5,
      "line-style": "dashed",
      "line-dash-pattern": [6, 3],
      "line-color": WA.kincha,
      "target-arrow-color": WA.kincha,
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

// Flow left→right so each generation is a column and siblings stack vertically,
// letting horizontal labels sit to the right without colliding.
export function dagreLR(
  extra: Partial<cytoscapeDagre.DagreLayoutOptions> = {},
): cytoscapeDagre.DagreLayoutOptions {
  return { name: "dagre", rankDir: "LR", animate: false, ...extra };
}

// Lay out the ego graph ranking on descent edges only — father→child, the hidden
// mother→child LAYOUT edges that co-rank couples, and adoptions — never spouse or
// sibling edges. fit:false because a prolific line is genuinely tall, so the caller
// opens at a readable zoom on the focus instead of fitting the whole pane.
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
