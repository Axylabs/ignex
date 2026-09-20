/**
 * @fileoverview Inline-SVG icon set — replaces emoji/glyph chrome with a
 * dependency-free monochrome set that inherits `currentColor`. Every glyph is
 * a single 24×24 stroke path (multi-subpath where a shape needs it), so the
 * component never depends on an icon package and renders identically without
 * native or network access.
 */
import type { JSX } from "solid-js";

/** Every icon the dashboard chrome uses. */
export type IconName =
  | "menu"
  | "chevron-left"
  | "chevron-down"
  | "chevron-right"
  | "search"
  | "close"
  | "refresh"
  | "pause"
  | "play"
  | "sun"
  | "moon"
  | "copy"
  | "external-link"
  | "trash"
  | "plus"
  | "alert"
  | "check"
  | "x-circle"
  | "database"
  | "file-text"
  | "book"
  | "list"
  | "activity"
  | "cpu"
  | "stethoscope"
  | "layers"
  | "briefcase"
  | "route"
  | "radio"
  | "package"
  | "sparkles"
  | "info"
  | "bolt"
  | "filter"
  | "clock"
  | "terminal"
  | "arrow-right";

/**
 * 24×24 stroke path data per icon. Geometry follows the Feather/Lucide
 * convention (arcs for circles, lines for rules) so the set stays visually
 * consistent at 12–20px. Kept private: consumers only see `IconName`/`Icon`.
 */
const PATHS: Record<IconName, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  search: "M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M21 21l-4.35-4.35",
  close: "M18 6L6 18M6 6l12 12",
  refresh: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4",
  pause: "M8 4v16M16 4v16",
  play: "M6 4l14 8-14 8z",
  sun: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  "external-link": "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  trash:
    "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6",
  plus: "M12 5v14M5 12h14",
  alert:
    "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  check: "M20 6L9 17l-5-5",
  "x-circle": "M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0M15 9l-6 6M9 9l6 6",
  database:
    "M12 2c4.42 0 8 1.34 8 3s-3.58 3-8 3-8-1.34-8-3 3.58-3 8-3zM4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3",
  "file-text":
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  book: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  cpu: "M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3",
  stethoscope:
    "M11 2v2M5 2v2M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1M8 15a6 6 0 0 0 12 0v-3M20 10m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  layers: "M12 2L2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5",
  briefcase:
    "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  route:
    "M6 19m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M18 5m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  radio:
    "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4.93 19.07a10 10 0 0 1 0-14.14M7.76 16.24a6 6 0 0 1 0-8.48M16.24 7.76a6 6 0 0 1 0 8.48M19.07 4.93a10 10 0 0 1 0 14.14",
  package:
    "M16.5 9.4L7.55 4.24M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  sparkles:
    "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4zM20 3v4M22 5h-4M4 17v2M5 18H3",
  info: "M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 16v-4M12 8h.01",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9z",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
  clock: "M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 6v6l4 2",
  terminal: "M4 17l6-6-6-6M12 19h8",
  "arrow-right": "M5 12h14M13 5l7 7-7 7",
};

/** Monochrome inline icon. */
export const Icon = (props: { name: IconName; size?: number; class?: string }): JSX.Element => (
  <svg
    class={props.class}
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={PATHS[props.name]} />
  </svg>
);
