"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildFamilyGraph,
  edgeId,
  egoDrawnEdges,
  junctionHiddenEdgeIds,
  junctionId,
  layoutOnlyEdges,
  mergeGraph,
  withoutAdoptions,
  type Graph,
  type JunctionId,
  type PersonId,
  type Sex,
  type SyntheticEdge,
} from "@/lib/graph";
import { washiGround } from "@/components/washiGround";
import {
  descentJunctions,
  placeNodes,
  project,
  projectOne,
  readPlacement,
  spouseRouting,
  type Pos,
  type Positions,
} from "@/lib/layout";
import {
  dagreLR,
  NODE_SIZE,
  RANK_SEP,
  ROW,
  runEgoLayout,
  SPOUSE_GUTTER,
  STYLE,
} from "@/lib/render";

cytoscape.use(dagre);

// `wikipediaTitle` (the ja.wikipedia sitelink) rides along so the article pane can
// open the canonical page when this person becomes the focus; absent ⇒ pane falls
// back to `label`.
export type FocusPerson = {
  qid: string;
  label: string;
  wikipediaTitle?: string;
};

// One generation's x-stride (a column). A node whose x differs by less than half
// this sits in the same generation column; more, a neighbouring one.
const COL = NODE_SIZE + RANK_SEP;
const ANIM_MS = 300;

// The node's on-screen label: the name, with the DB degree appended as a badge
// when known. `label` stays the pure name (article pane / focus callbacks read it);
// only this display string carries the number.
function nodeDisp(label: string, degree: number | undefined): string {
  return degree === undefined ? label : `${label}  ${degree}`;
}

export function GraphPane(props: {
  focus: FocusPerson;
  pathTo?: FocusPerson | null;
  showAdoptions?: boolean;
  onSelect: (person: FocusPerson) => void;
  onCurrent: (person: FocusPerson) => void;
}) {
  // Mounted with a key derived from focus + pathTo (see page.tsx), so each instance
  // is single-mode: path view (one-shot shortest path) or ego view (accretion). The
  // two diverged enough — persistent, growing cytoscape vs. rebuilt-per-fetch — that
  // they're separate components rather than one branchy effect.
  return props.pathTo ? (
    <PathPane
      focus={props.focus}
      pathTo={props.pathTo}
      onSelect={props.onSelect}
    />
  ) : (
    <EgoPane
      focus={props.focus}
      showAdoptions={props.showAdoptions ?? false}
      onCurrent={props.onCurrent}
    />
  );
}

// ---------------------------------------------------------------------------
// Path view: unchanged one-shot render of the shortest path between two people.
// ---------------------------------------------------------------------------
function PathPane({
  focus,
  pathTo,
  onSelect,
}: {
  focus: FocusPerson;
  pathTo: FocusPerson;
  onSelect: (person: FocusPerson) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/path?from=${encodeURIComponent(focus.qid)}&to=${encodeURIComponent(pathTo.qid)}`;
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(`経路の取得に失敗しました (${res.status})`);
        return (await res.json()) as Graph;
      })
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "経路の取得に失敗しました",
        );
      });
    return () => controller.abort();
  }, [focus.qid, pathTo.qid]);

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({
        data: {
          id: n.qid,
          label: n.label,
          disp: n.label, // path view shows no degree badge; disp is just the name
          // Carried so a tap can re-focus with the canonical article title (below).
          wikipediaTitle: n.wikipediaTitle,
          sex: n.sex,
          focus: n.qid === focus.qid || n.qid === pathTo.qid ? 1 : 0,
        },
      })),
      ...graph.edges.map((e) => ({
        data: {
          id: `${e.source}|${e.type}|${e.target}`,
          source: e.source,
          target: e.target,
          type: e.type,
        },
      })),
    ];
    const cy: Core = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLE,
    });
    cy.layout(dagreLR()).run(); // small graph: default fit is fine
    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      onSelect({ qid: d.id, label: d.label, wikipediaTitle: d.wikipediaTitle });
    });
    return () => cy.destroy();
  }, [graph, focus.qid, pathTo.qid, onSelect]);

  const loading = !graph && !error;
  // A path request that finds nothing returns an empty graph (vs. a missing-person
  // 404, which throws above); distinguish it so the user sees a clear message.
  const noPath = !!graph && graph.nodes.length === 0;

  return (
    <div className="relative h-full w-full" style={washiGround}>
      {loading && (
        <p className="text-muted absolute top-3 left-3 z-10 text-sm">
          経路を探索中…
        </p>
      )}
      {error && (
        <p className="text-vermilion absolute top-3 left-3 z-10 text-sm">
          {error}
        </p>
      )}
      {noPath && (
        <p className="text-muted absolute top-3 left-3 z-10 text-sm">
          経路が見つかりません
        </p>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ego view: accretion navigation (issue #49). The anchor (`focus`) is the fixed
// layout root; firing a node (tap / Enter) fetches its direct neighbours, merges
// them into a growing graph, and re-runs the existing layout pipeline with the
// anchor as focusId — animating positions instead of rebuilding, never recentering.
// ---------------------------------------------------------------------------

// Everything the live cytoscape needs to draw one layout state, computed on a
// throwaway headless cy so the live one's current positions survive for animation.
type EgoPlan = {
  personIds: string[];
  labels: Map<string, string>;
  degrees: Map<string, number | undefined>; // person qid → DB total degree, for the badge
  // ja.wikipedia sitelink per person, so a fired node can open the canonical article.
  wikipediaTitles: Map<string, string | undefined>;
  sexes: Map<string, Sex | undefined>; // person qid → sex, for the node's shape/colour
  positions: Map<string, Pos>; // person + junction id → pixels
  // Drawn person edges; the ones in `hiddenEdgeIds` are kept but hidden (replaced
  // by a midpoint junction line), matching the previous renderer.
  personEdges: { id: string; source: string; target: string; type: string }[];
  hiddenEdgeIds: Set<string>;
  junctions: { id: JunctionId; pos: Pos }[];
  descentEdges: { id: string; source: JunctionId; target: PersonId }[];
  spouseBows: Map<string, number>; // spouse edge id → bow distance
};

// Deterministic reproduction of the ego layout (mirrors GraphPane's original inline
// pass and scripts/dump-layout.ts): run dagre + the placement passes on a headless
// cy, then hand back positions and the draw plan. Pure over (graph, focus).
function computeEgoPlan(
  graph: Graph,
  focus: PersonId,
  showAdoptions: boolean,
): EgoPlan {
  const g = showAdoptions ? graph : withoutAdoptions(graph, focus);
  const edges = egoDrawnEdges(g);
  const layoutEdges = layoutOnlyEdges(g, edges);
  const elements: ElementDefinition[] = [
    ...g.nodes.map((n) => ({ data: { id: n.qid, label: n.label } })),
    ...[...edges, ...layoutEdges].map((e) => ({
      data: {
        id: edgeId(e),
        source: e.source,
        target: e.target,
        type: e.type,
      },
    })),
  ];
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: STYLE,
  });
  runEgoLayout(cy);
  const raw: Positions = new Map();
  cy.nodes().forEach((n) => {
    raw.set(n.id() as PersonId, { x: n.position("x"), y: n.position("y") });
  });
  const fam = buildFamilyGraph(g, edges);
  const { placements, colX } = readPlacement(raw, ROW);
  const placed = placeNodes(placements, fam, focus);
  const px = project(placed, colX, ROW);
  const positions: Map<string, Pos> = new Map(px);

  const spouseBows = new Map<string, number>();
  for (const { source, target, bow } of spouseRouting(px, fam, SPOUSE_GUTTER)) {
    spouseBows.set(edgeId({ source, type: "SPOUSE_OF", target }), bow);
  }

  const junctionList = descentJunctions(fam, placed);
  const junctions: EgoPlan["junctions"] = [];
  const descentEdges: EgoPlan["descentEdges"] = [];
  const hiddenEdgeIds = junctionHiddenEdgeIds(junctionList);
  for (const j of junctionList) {
    const jid = junctionId(j.father, j.mother);
    const jpos = projectOne(j.pos, colX, ROW);
    junctions.push({ id: jid, pos: jpos });
    positions.set(jid, jpos);
    for (const child of j.children) {
      descentEdges.push({ id: `${jid}->${child}`, source: jid, target: child });
    }
  }

  // Release the throwaway instance: styleEnabled headless cytoscape starts an
  // animation loop that leaks across the per-fire/per-toggle recomputes otherwise.
  cy.destroy();
  return {
    personIds: g.nodes.map((n) => n.qid),
    labels: new Map(g.nodes.map((n) => [n.qid, n.label])),
    // The badge follows the view: the blood view (adoptions off) counts only
    // blood/marriage ties, the adoption view adds adoptive ones.
    degrees: new Map(
      g.nodes.map((n) => [
        n.qid,
        showAdoptions ? n.degreeWithAdoptions : n.degree,
      ]),
    ),
    wikipediaTitles: new Map(g.nodes.map((n) => [n.qid, n.wikipediaTitle])),
    sexes: new Map(g.nodes.map((n) => [n.qid, n.sex])),
    positions,
    personEdges: edges.map((e) => ({
      id: edgeId(e),
      source: e.source,
      target: e.target,
      type: e.type,
    })),
    hiddenEdgeIds,
    junctions,
    descentEdges,
    spouseBows,
  };
}

// Apply a plan to the live cytoscape: reconcile elements (add new, drop stale),
// animate existing nodes to their new positions, and sprout new nodes out of
// `emergeFrom` (the fired node) so a branch reads as growing. No dagre runs here.
function renderEgoPlan(
  cy: Core,
  plan: EgoPlan,
  opts: { animate: boolean; emergeFrom?: Pos },
): void {
  const wantNodes = new Set<string>([
    ...plan.personIds,
    ...plan.junctions.map((j) => j.id),
  ]);
  const wantEdges = new Set<string>([
    ...plan.personEdges.map((e) => e.id),
    ...plan.descentEdges.map((e) => e.id),
  ]);
  cy.edges().forEach((e) => {
    if (!wantEdges.has(e.id())) e.remove();
  });
  cy.nodes().forEach((n) => {
    if (!wantNodes.has(n.id())) n.remove();
  });

  for (const id of plan.personIds) {
    const pos = plan.positions.get(id);
    if (!pos) continue;
    const label = plan.labels.get(id) ?? id;
    const disp = nodeDisp(label, plan.degrees.get(id));
    const existing = cy.getElementById(id);
    if (existing.empty()) {
      const n = cy.add({ data: { id, label, disp, sex: plan.sexes.get(id) } });
      n.position(opts.emergeFrom ?? pos);
      if (opts.animate && opts.emergeFrom)
        n.animate({ position: pos }, { duration: ANIM_MS });
      else n.position(pos);
    } else {
      // Refresh disp so the badge follows the adoption toggle: the same node's
      // degree differs between the blood and adoption views.
      existing.data("disp", disp);
      if (opts.animate)
        existing
          .stop(true, false)
          .animate({ position: pos }, { duration: ANIM_MS });
      else existing.position(pos);
    }
  }

  // Junctions are invisible anchors for the descent lines; snap them (no animation
  // to a point nobody sees) so the child edges route from the right midpoint.
  for (const j of plan.junctions) {
    const existing = cy.getElementById(j.id);
    if (existing.empty())
      cy.add({ data: { id: j.id, junction: 1 } }).position(j.pos);
    else existing.position(j.pos);
  }

  for (const e of plan.personEdges) {
    if (cy.getElementById(e.id).empty()) {
      cy.add({
        data: { id: e.id, source: e.source, target: e.target, type: e.type },
      });
    }
    const ed = cy.getElementById(e.id);
    ed.style("visibility", plan.hiddenEdgeIds.has(e.id) ? "hidden" : "visible");
    if (e.type === "SPOUSE_OF") {
      const bow = plan.spouseBows.get(e.id);
      if (bow === undefined) {
        ed.removeStyle("segment-weights segment-distances");
        ed.style("curve-style", "straight");
      } else {
        ed.style("curve-style", "segments");
        ed.style("segment-weights", "0.08 0.92");
        ed.style("segment-distances", `${bow} ${bow}`);
      }
    }
  }

  for (const e of plan.descentEdges) {
    if (cy.getElementById(e.id).empty()) {
      cy.add({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "DESCENT" satisfies SyntheticEdge,
        },
      });
    }
  }
}

function EgoPane({
  focus,
  showAdoptions,
  onCurrent,
}: {
  focus: FocusPerson;
  showAdoptions: boolean;
  onCurrent: (person: FocusPerson) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const graphRef = useRef<Graph>({ nodes: [], edges: [] });
  // Monotonic id so only the latest-issued fire applies: rapid taps/Enters race,
  // and without this the last-*resolved* fetch would win over the last-*issued* one.
  const fireSeqRef = useRef(0);
  const currentRef = useRef<PersonId>(focus.qid as PersonId);
  const cursorRef = useRef<PersonId>(focus.qid as PersonId);
  const showAdoptionsRef = useRef(showAdoptions);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const paint = useCallback((cy: Core) => {
    cy.nodes().removeClass("current cursor");
    cy.getElementById(currentRef.current).addClass("current");
    cy.getElementById(cursorRef.current).addClass("cursor");
  }, []);

  // Set up the persistent cytoscape once per anchor, wire input, and auto-fire the
  // anchor. Deliberately excludes showAdoptions from deps — toggling it re-renders
  // the accumulated graph (separate effect below) without tearing down accretion.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cy = cytoscape({ container, style: STYLE });
    cyRef.current = cy;
    graphRef.current = { nodes: [], edges: [] };
    currentRef.current = focus.qid as PersonId;
    cursorRef.current = focus.qid as PersonId;

    const controller = new AbortController();
    let destroyed = false;

    async function fire(id: PersonId) {
      // Per-fire token (not per-mount): rapid taps/Enters each bump it, so only
      // the latest-issued fire applies its result below.
      const seq = ++fireSeqRef.current;
      try {
        // Seed the initial auto-fire with 2 hops for a richer first view; every
        // later fire adds just the fired person's direct neighbours (1 hop).
        const firstRender = graphRef.current.nodes.length === 0;
        const hops = firstRender ? 2 : 1;
        const res = await fetch(
          `/api/person/${encodeURIComponent(id)}/neighbors?hops=${hops}`,
          { signal: controller.signal },
        );
        if (!res.ok)
          throw new Error(`グラフの取得に失敗しました (${res.status})`);
        const g = (await res.json()) as Graph;
        // Superseded by a newer fire (or unmounted): drop this one so a slow
        // response can't clobber the current node, camera, or render.
        if (destroyed || seq !== fireSeqRef.current) return;
        graphRef.current = mergeGraph(graphRef.current, g);
        const firedEl = cy.getElementById(id);
        const emergeFrom = firedEl.nonempty()
          ? { ...firedEl.position() }
          : undefined;
        const plan = computeEgoPlan(
          graphRef.current,
          focus.qid as PersonId,
          showAdoptionsRef.current,
        );
        renderEgoPlan(cy, plan, { animate: !firstRender, emergeFrom });
        currentRef.current = id;
        cursorRef.current = id;
        paint(cy);
        onCurrent({
          qid: id,
          label: plan.labels.get(id) ?? id,
          wikipediaTitle: plan.wikipediaTitles.get(id),
        });
        // Open on the anchor once; later fires keep the camera where the user left it.
        if (firstRender) {
          cy.zoom(0.8);
          cy.center(cy.getElementById(focus.qid));
        }
        setError(null);
        setReady(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "グラフの取得に失敗しました",
        );
      }
    }

    // Returns whether the cursor actually moved; the caller expands (fires) the
    // current node when there is nothing further in that direction (an edge node).
    function moveCursor(dir: "h" | "j" | "k" | "l"): boolean {
      const cur = cy.getElementById(cursorRef.current);
      if (cur.empty()) return false;
      const { x, y } = cur.position();
      let best: string | null = null;
      let bestDist = Infinity;
      cy.nodes().forEach((n) => {
        if (n.data("junction") || n.id() === cursorRef.current) return;
        const p = n.position();
        const dx = p.x - x;
        const dy = p.y - y;
        const sameCol = Math.abs(dx) < COL / 2;
        const ok =
          dir === "h"
            ? dx < -COL / 2
            : dir === "l"
              ? dx > COL / 2
              : dir === "j"
                ? sameCol && dy > 1
                : sameCol && dy < -1;
        if (!ok) return;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = n.id();
        }
      });
      if (best) {
        cursorRef.current = best as PersonId;
        paint(cy);
        return true;
      }
      return false;
    }

    function onKey(e: KeyboardEvent) {
      // App-level shortcut on window (not the container) so it works regardless of
      // where focus landed — but never while the user is typing in the search box.
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      ) {
        return;
      }
      // At an edge (no node further in this direction) the move fails, so expand
      // the current node instead — walking into the void grows the tree.
      switch (e.key) {
        case "h":
        case "ArrowLeft":
          e.preventDefault();
          if (!moveCursor("h")) fire(cursorRef.current);
          break;
        case "l":
        case "ArrowRight":
          e.preventDefault();
          if (!moveCursor("l")) fire(cursorRef.current);
          break;
        case "j":
        case "ArrowDown":
          e.preventDefault();
          if (!moveCursor("j")) fire(cursorRef.current);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          if (!moveCursor("k")) fire(cursorRef.current);
          break;
        case "Enter":
        case " ": // Space fires, same as Enter
          e.preventDefault();
          fire(cursorRef.current);
          break;
      }
    }

    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      if (d.junction) return;
      cursorRef.current = d.id as PersonId;
      fire(d.id as PersonId);
    });
    window.addEventListener("keydown", onKey);

    fire(focus.qid as PersonId);

    return () => {
      destroyed = true;
      controller.abort();
      window.removeEventListener("keydown", onKey);
      cy.destroy();
      cyRef.current = null;
    };
  }, [focus.qid, onCurrent, paint]);

  // Re-render the accumulated graph when the adoption toggle flips, without
  // refetching or resetting accretion.
  useEffect(() => {
    showAdoptionsRef.current = showAdoptions;
    const cy = cyRef.current;
    if (!cy || graphRef.current.nodes.length === 0) return;
    const plan = computeEgoPlan(
      graphRef.current,
      focus.qid as PersonId,
      showAdoptions,
    );
    renderEgoPlan(cy, plan, { animate: false });
    // Turning the toggle off can drop the node the cursor/current sat on (an
    // adoptive-only relative). Snap both back to the anchor so keyboard nav keeps
    // working and the highlight/article don't reference a vanished node.
    if (cy.getElementById(currentRef.current).empty()) {
      currentRef.current = focus.qid as PersonId;
      onCurrent(focus);
    }
    if (cy.getElementById(cursorRef.current).empty()) {
      cursorRef.current = focus.qid as PersonId;
    }
    paint(cy);
  }, [showAdoptions, focus, onCurrent, paint]);

  return (
    <div className="relative h-full w-full" style={washiGround}>
      {!ready && !error && (
        <p className="text-muted absolute top-3 left-3 z-10 text-sm">
          グラフを読み込み中…
        </p>
      )}
      {error && (
        <p className="text-vermilion absolute top-3 left-3 z-10 text-sm">
          {error}
        </p>
      )}
      <div ref={containerRef} className="h-full w-full outline-none" />
    </div>
  );
}
