/**
 * @fileoverview Hash router — the SPA's deep-linkable view state.
 *
 * Routes look like `#/requests`, `#/requests/:id/:tab?`, `#/logs/:id?`. The
 * parsed route lives in a Solid signal, so views and nav highlight react to
 * it; the browser back button and refresh work for free. Unknown hashes fall
 * back to `requests`.
 */

import { createSignal } from "solid-js";

/** Parsed route: primary view + optional detail id/tab segments. */
export interface Route {
  /** Primary view id (registry key). */
  view: string;
  /** Detail resource id (request/log id) when present. */
  id: string | null;
  /** Detail tab segment when present. */
  tab: string | null;
}

const KNOWN_VIEWS = new Set([
  "requests",
  "errors",
  "logs",
  "history",
  "metrics",
  "diagnostics",
  "system",
  "state",
  "jobs",
  "routes",
  "events",
  "clients",
  "ai",
  "kt",
]);

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const head = parts[0] ?? "";
  if (!KNOWN_VIEWS.has(head)) return { view: "requests", id: null, tab: null };
  if (head === "requests" && parts[1] !== undefined) {
    // `#/requests/<id>/<tab?>` is the request-detail surface.
    return { view: "detail", id: decodeURIComponent(parts[1]), tab: parts[2] ?? null };
  }
  if (head === "logs" && parts[1] !== undefined) {
    return { view: "logDetail", id: decodeURIComponent(parts[1]), tab: null };
  }
  return { view: head, id: null, tab: null };
}

const [route, setRoute] = createSignal<Route>(parse(window.location.hash));

/** Structurally-equal routes are no-ops (the browser re-fires hashchange). */
const routeEquals = (a: Route, b: Route): boolean =>
  a.view === b.view && a.id === b.id && a.tab === b.tab;

/** Parse + publish a hash, skipping no-op re-parses (hashchange re-entry). */
const applyHash = (hash: string): void => {
  const parsed = parse(hash);
  if (!routeEquals(parsed, route())) setRoute(parsed);
};

window.addEventListener("hashchange", () => {
  applyHash(window.location.hash);
});

/** Current route (reactive). */
export const currentRoute = route;

/**
 * Navigate to a hash route. Detail routes build their full hash
 * (`#/requests/<id>/<tab>`); plain views reset to their canonical form.
 * The route signal updates synchronously; the browser's later hashchange
 * re-parse is a no-op via the equality guard.
 */
export const navigate = (view: string, id?: string, tab?: string): void => {
  let hash = `#/${view}`;
  if (view === "errors" || view === "detail") {
    // Canonical forms live under requests/.
    if (view === "errors") hash = "#/errors";
    else if (id !== undefined) hash = `#/requests/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
  } else if (view === "logDetail") {
    hash = id !== undefined ? `#/logs/${encodeURIComponent(id)}` : "#/logs";
  }
  if (window.location.hash === hash) {
    applyHash(hash); // re-enter same route (manual refresh)
  } else {
    window.location.hash = hash;
    applyHash(hash);
  }
};
