---
name: layout-debugging
description: Use when debugging the kakeizu family-tree graph layout — a bent or wrongly-routed descent line, a misplaced node, a wrong generation/column, or adoption rendered incorrectly. Reproduces GraphPane's dagre layout offline and dumps exact coordinates so geometry bugs show up as numbers. Prefer this over poking the live browser.
---

# Debugging kakeizu graph layout

The family-tree layout is computed by dagre (cytoscape-dagre), which is
**deterministic**: same nodes/edges + same options ⇒ same coordinates. So you can
reproduce the browser's exact geometry offline — no clicking around the page.

## Do this, not that

- **DO** run `scripts/dump-layout.ts` to get coordinates and line paths as numbers.
- **DO** use the browser only for the _final_ visual confirmation of a fix.
- **DON'T** improvise a new debug method each time (exposing `window.cy`,
  screenshotting and guessing). The script already exists; use it.

## Reproduce the layout

Dev server must be up (`bun run dev`; the script reads `/api/person/:id/neighbors`).

```bash
bun run scripts/dump-layout.ts <QID>   # QID optional, default Q319664 (徳川吉宗)
```

It mirrors `components/GraphPane.tsx`'s layout step exactly (dagre ranking with
`nonRankingAdoptiveEdges` excluded → `placeNodes` → `spouseRouting` →
`descentJunctions`, and `sameGenerationAdoptiveEdges` marked hidden).

## Read the output

- **Nodes** `x, y` — `x` is the generation column. Two people in the same
  generation must share an `x`.
- **Drawn descent lines** — taxi path + `[cols=column span, bends]`.
  - `cols≥2` is the red flag: a descent line crossing an extra column means the
    child is placed a generation too deep (the usual cause of an "unnecessary
    bend"). Every normal line is `cols=1`.
  - `HIDDEN (same-gen adoption)` = a same-column adoptive edge (家督 succession
    between kin) that is intentionally not drawn.
- **Descent junctions** — couple-midpoint origin of a descent line + `dy` to each
  child.
- **Spouse detours** — marriage lines bowed around a blocking node.

## Code map

- `lib/graph.ts` — edge reduction: `patrilinealEdges`, `layoutOnlyEdges`,
  `nonRankingAdoptiveEdges` (adoptive edges kept out of dagre ranking).
- `lib/layout.ts` — pure placement on plain coordinates: `placeNodes`,
  `spouseRouting`, `descentJunctions`, `sameGenerationAdoptiveEdges`.
- `components/GraphPane.tsx` — the cytoscape adapter: reads dagre coords, runs the
  pure rules, writes them back, hides/styles edges. No placement logic lives here.

## Non-regression

`bun run scripts/layout-parity.ts` checks the pure `lib/layout` functions against
the original cytoscape-coupled placement on real ego graphs. Run it after touching
placement code; it must print `PARITY OK`.
