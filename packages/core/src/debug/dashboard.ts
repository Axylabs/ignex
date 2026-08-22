/**
 * @fileoverview Debugbar dashboard assets — barrel.
 *
 * The dashboard is three same-origin resources served by the `debugbar()`
 * plugin:
 *   - `index.html`  — the shell (`dashboard-html.ts`)
 *   - `app.css`     — the design system stylesheet (`dashboard-css.ts`)
 *   - `app.js`      — the app (`dashboard-js.ts`)
 *
 * All are self-contained (no external deps, no build step) so the dashboard
 * works on any Bun dev box with zero installs. `__BASE__` in the HTML/CSS/JS
 * is replaced by the plugin with the configured path.
 */

export { DEBUGBAR_DASHBOARD_CSS } from "./dashboard-css";
export { DEBUGBAR_DASHBOARD_HTML } from "./dashboard-html";
export { DEBUGBAR_DASHBOARD_JS } from "./dashboard-js";
