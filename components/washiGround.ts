import type { CSSProperties } from "react";

// Paper-fibre texture over the 生成り ground so it reads as unbleached paper,
// not a flat fill. Grayscale fractal noise at low opacity, kept subtle enough
// not to compete with the graph. Defined here (TS) rather than as a class in
// globals.css because Turbopack doesn't hot-reload the CSS entry in dev, so
// tuning it there needs a server restart; a TS constant hot-reloads. Shared by
// the body ground (layout) and the graph canvas (GraphPane).
export const washiGround: CSSProperties = {
  backgroundColor: "var(--color-washi)",
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.2'/%3E%3C/svg%3E\")",
};
