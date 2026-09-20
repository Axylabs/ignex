# Debugbar dashboard — UI redesign & design system

- **Status:** design approved in chat; awaiting written-spec review
- **Date:** 2026-09-21
- **Owner:** debugbar (`packages/core/src/debug/ui`)
- **Type:** architectural (restructures the SPA's design system + every view's layout)
- **Source of truth for styles today:** `packages/core/src/debug/ui/styles.css`
- **Disposition:** this is a design-phase spec. Once the redesign lands, the
  still-live design content is folded into `docs/debugbar-ui.md` (the style
  guide, §8) and this dated file is deleted, per the docs discipline in
  `AGENTS.md`.

## 1. Context

The debugbar dashboard is a dependency-free SolidJS + Tailwind SPA, compiled
ahead of time into the committed `packages/core/src/debug/dashboard-client.gen.ts`
by `scripts/gen-debug-ui.ts`. It has 15 top-level panels plus two detail
surfaces. It works, but it does not read as a product: layouts are inconsistent
view to view, the visual language is undirected, and there are real rendering
bugs.

The goal is a **dense, neutral developer tool** (Chrome DevTools / Grafana class):
near-neutral surfaces, one restrained interactive accent, monospace numerics,
compact rows, high contrast, dark-first with true light parity, and a **written
style guide** the codebase is held to.

## 2. Goals

- One documented design system (tokens, type/spacing/radius scale, component
  contract) applied consistently across the shell and all 17 surfaces.
- A single page-layout contract so every view reads the same way.
- Replace 15 co-equal top-level tabs with a grouped, collapsible sidebar.
- Fix the concrete layout/theme/contrast bugs catalogued in §3.
- Targeted UX improvements: per-view headers + actions, one toolbar/filter
  pattern, real empty/loading/error states, view state that survives
  navigation, and a `Cmd/Ctrl-K` command palette.
- Meet a documented accessibility bar.
- **Tailwind-first:** primitives are TSX composed from Tailwind utilities bound
  to tokens via `@theme inline`. `styles.css` shrinks to tokens + `@theme` + the
  irreducible custom bits (waterfall geometry, canvas sizing, markdown
  typography, keyframes). No new runtime dependency.

## 3. Non-goals

- No change to the wire API, endpoints, data shapes, data flow, or the
  server-side debug modules.
- No change to routing semantics: every hash deep link keeps working, including
  `#/requests/<id>/<tab>` and `#/docs/<encodeURIComponent(path)>`.
- No virtualization, resizable panels, saved filter presets, or other heavy
  interaction work.
- No new npm dependency (icons are inline SVG; the palette and tabs are built
  from existing primitives).
- No change to production behaviour: the AOT elimination guarantees in
  `docs/debugbar.md` are unaffected.

## 4. Constraints

- Stays SolidJS + Tailwind, AOT-built. Artifact must be regenerated with
  `bun run gen:debug-ui`; `check:debug-ui` must pass.
- Existing tests must stay green, including strings the executed-bundle smoke
  asserts (see §11).
- `jsdoc:check:strict` and `check:maintainability` are gates; docs discipline in
  `AGENTS.md`/`RULES.md` applies (one owner per topic in `docs/README.md`).

## 5. Current-state findings (measured)

| # | Finding | Evidence |
|---|---|---|
| 1 | Two competing systems: Tailwind utilities mixed with a large semantic CSS layer | `ui/` uses `grid grid-cols-[280px_1fr]`, `px-4 py-3.5`, `text-[11.5px]`, `mt-2` alongside `.panel`, `.client-card`, `.kt-row`, `.verdict` |
| 2 | Every card re-declared | `.panel`, `.stat`, `.client-card`, `.kt-area`, `.kt-row`, `.verdict`, `.summary`, `.kt-callout`, `details.panel` each restate border+radius+bg |
| 3 | 15 distinct font sizes | styles.css: 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 17, 20, 22, 26, 32 px; plus `text-[10.5px]/[11px]/[11.5px]` literals |
| 4 | No page-layout contract | No view has a consistent header; each starts with a `StatRow`, a toolbar, or a summary bar. Only the shell and KT have a heading |
| 5 | 15 ungrouped nav items, no overflow strategy | `app.tsx` renders `VIEWS` in one flex row; under `@media max-width:860px` it only shrinks the font |
| 6 | Docs layout breaks narrow | `views/docs.tsx`: `grid grid-cols-[280px_1fr]` with no responsive rule |
| 7 | Stat glow is always accent | `styles.css` `.stat::after` uses `--accent` even on `.err/.warn/.ok` cards |
| 8 | Waterfall hover invisible in light | `.wf-bar:hover { outline: 1px solid #fff }` |
| 9 | `pre.mini` low contrast | uses `--panel` inside a `--panel` panel; all other `pre` use `--panel2` |
| 10 | Sticky table headers are tied to the global top bar, not their table | `thead th { position: sticky; top: var(--topbar-h) }`; tables sit in non-scrolling panels, so the header sticks to the viewport and detaches from its panel/heading — and the offset is hard-coded to the old top-bar height, which the new shell removes |
| 11 | Light theme is partial | only ~8 of ~30 tokens switch; `--m-*`/`--k-*`, `--panel-glass`, `--accent-dim` keep dark-tuned values |
| 12 | Fixed widths break on long content | `.wf-detail { margin-left: 240px }`, `.bd-row .name { width: 120px }`, `.client-meta` `minmax`, etc. |
| 13 | Accent means nothing | the same gradient is used for the logo, active nav, primary button, and the KT title |
| 14 | Contrast failure | `--faint` `#5d6d80` on `--panel` `#11171f` ≈ 2.8:1 (below 4.5:1) |
| 15 | Emoji/glyph icons used as chrome | `⚡ ◐ ⏸ ▶ ↻ ✕ ⚠ ✔ ✖ 🗄 📄 📚 📈 🗺 📦 ⚙ 🧘 🔌 🔍 🔗 🗒 …` |
| 16 | Dead hooks and dead CSS | `.topbar`, `.statusbar`, `.sub`, `.toast.show` referenced in TSX but **undefined**; `.ok-text`, `.brand-sub`, `pre.codeblock` defined but referenced nowhere |
| 17 | No style guide | `docs/README.md` has no UI/design-system owner |

## 6. Design

### 6.1 Foundations

**Color.** Keep the `data-theme` attribute + `@theme inline` mapping (correct and
dependency-free). Redefine the token vocabulary by role:

| Token | Role | Replaces |
|---|---|---|
| `--bg` | app canvas | `--bg` |
| `--surface-1/2/3` | card / raised / input-track | `--panel`, `--raised`, `--panel2` |
| `--border`, `--border-strong` | hairlines | same |
| `--text`, `--text-muted`, `--text-faint` | three text levels, each ≥4.5:1 on `--surface-1` | `--text`, `--muted`, `--faint` |
| `--accent`, `--accent-fg`, `--accent-soft` | the single interactive color + its on-color and tint | `--accent`, `--accent2`, ad-hoc `color-mix` |
| `--ok/--warn/--err/--info` + `--*-soft` | status | per-site `color-mix` |
| `--cat-1…8` | categorical data (span kinds, HTTP methods) | `--m-*` + `--k-*` |
| `--overlay` | one translucent surface for palette/dialog/drawer | `--panel-glass`, `--panel-glass-solid` |

Removed: gradients, glows, decorative shadows, and the accent halo on every stat
card. **Light theme redefines the complete token list** (not a subset). On first
visit the theme follows `prefers-color-scheme`; the `t` toggle and persistence
are unchanged.

**Type.** One 6-step ramp replaces the 15 sizes:
`--fs-xs 11 · --fs-sm 12 · --fs-md 13 · --fs-lg 15 · --fs-xl 20 · --fs-2xl 28`,
with line-heights tight 1.25 / normal 1.5. All numbers, ids, paths and code use
`--font-mono` with `font-variant-numeric: tabular-nums`.

**Spacing.** Tailwind's 4px scale; remove bespoke px margins
(`.panel{margin-bottom:14px}`, `.stats{margin-bottom:14px}`) in favour of
flex/grid `gap` on a stack primitive.

**Radius.** `6 / 8 / 12` plus full pills. **Motion.** 120ms on
color/border/background only; drop `translateY(-1px)` card-lift and hover glows;
keep the fresh-row flash and live-dot pulse; keep `prefers-reduced-motion`.
**Elevation.** 1px borders, not shadows; one soft shadow reserved for overlays.

**Icons.** All chrome icons become a ~24-glyph inline-SVG set at
`ui/components/icon.tsx` (16px, `stroke="currentColor"`, no dependency).
Data-typographic marks stay (`↳` wire round-trip, `…idle`, `→` target).

**Accent discipline (normative).** Accent marks interactive/active state only:
active nav, focus ring, links, primary button, selected-row edge. Never
decorative titles or numbers. Status uses semantic tokens; categories use
`--cat-*`.

### 6.2 Shell & navigation

- Layout: CSS grid `[sidebar] 1fr`; sidebar sticky and full-height; content
  column scrolls.
- Sidebar (220px): brand block (service + environment chip) → four labelled
  groups:
  - **Observe** — Requests, Errors, Logs, History
  - **Runtime** — Metrics, System, Diagnostics, State, Jobs
  - **Integrations** — Events, Clients
  - **Reference** — KT, Docs, AI
  Each item is an inline-SVG icon + label + optional live badge (e.g. error count
  on Errors) with `aria-current="page"` when active.
- Collapse: ≤1100px → 56px icon rail (tooltips + `aria-label`); ≤760px →
  off-canvas drawer + hamburger. Preference persisted in `localStorage`.
- Context bar (replaces the 15-button nav strip): breadcrumb (`service / View`),
  live-tail indicator, refresh, theme, command-palette trigger. Per-view actions
  move into the view's own `PageHeader`.
- Status bar: one row, separated groups, `env(safe-area-inset-bottom)`; keeps
  native/buffer/cheat-sheet content.
- **Routes and deep links are unchanged.**

### 6.3 Command palette

`Cmd/Ctrl-K` opens a fuzzy palette over the 15 views plus quick actions
(refresh, pause/resume live, toggle theme, open request or log by id, open doc
by path). Arrow keys / Enter / Esc; focus trap; `role="dialog"` with
`aria-modal`. `/` continues to focus the active view's search field.

### 6.4 Component contract

New primitives under `ui/components/`:

`AppShell` · `Sidebar` / `NavItem` · `PageHeader` (title/description/actions/
breadcrumb) · `Toolbar` · `Card` + `Panel` · `Stat` / `StatRow` · `DataTable` ·
`Badge` (method/status/kind/level/sql folded into one `tone`-driven component) ·
`Chip` · `Button` (primary/ghost/danger/icon × sm/md) · `Field` / `Select` /
`SearchInput` · `Tabs` (ARIA tablist) · `EmptyState` / `LoadingState` /
`ErrorState` · `Kvs` · `Bar` / `StackedBar` · `Waterfall` · `Callout` ·
`Markdown` · `Icon`.

**Normative rule (the style guide's core):** utilities for layout only;
components for appearance; tokens for color; zero arbitrary `[px]` values.

Deleted one-offs (folded into primitives): `.client-card`, `.verdict`,
`.summary`, `.kt-area`, `.kt-row`, `.prom-url`, `.f-head`, `.f-title`,
`.f-detail`, `.f-reco`, `.sev-*`, `.log-msg`, `.routes-cell`. Also deleted as
dead: `.topbar`, `.statusbar`, `.sub`, `.toast.show`, `.brand-sub`, `.ok-text`,
`pre.codeblock`.

### 6.5 Page archetypes

| Archetype | Views | Shape |
|---|---|---|
| List / monitor | Requests, Errors, Logs, History, Routes, Jobs, Events, Clients | `PageHeader` → `StatRow` → `Toolbar` → `DataTable` (card grid for Clients) → states |
| Dashboard | Metrics, System, Diagnostics, State | `PageHeader` → `StatRow` → card grid / tables / callouts |
| Detail | Request detail, Log detail | `PageHeader` → summary strip → ARIA `Tabs` → panels |
| Reference | KT, Docs | `PageHeader`/hero → sectioned cards |

### 6.6 Per-view changes

- **Requests / Errors** — header owns title/description and actions
  (pause/resume, refresh, clear as danger); toolbar keeps search (`id="search"`)
  + method/status selects and sticks under the context bar; duration column
  right-aligned tabular; error cell truncates with `title`. Module-scoped store,
  keyed merge and fresh-row flash preserved.
- **Logs** — filters in toolbar; *persisted* becomes a header segmented control;
  message column gets a real max-width + `title`.
- **History** — header + retention hint; stats render only when persistence is
  live; toolbar keeps since/until/q/method/status/error/minMs.
- **Routes** — search + count; chip cluster becomes wrapping `Badge`s.
- **Jobs** — status stat row + recent table; local hand-rolled `StatusPill`
  deleted.
- **Events** — stat row; NATS publish and Nova emit composers become consistent
  `Card`s using `Field`/`Select`/`Button` (replaces `.publish-composer`'s
  `grid-row: span 2`); toolbar gains search + source/direction filters.
- **Clients** — card grid: header (name + kind/status badges), meta grid, tags,
  copyable files.
- **Metrics** — one `StatGrid` instead of two stacked `StatRow`s; per-route
  table right-aligned; counters and Prometheus card keep behaviour.
- **System** — shared `Chart` component (fixed height, no bare `canvas{}`
  selector) in a 2×2 grid with title, current value and min/max; canvas gets
  `role="img"` + `aria-label` and the values are also present as text.
- **Diagnostics** — verdict banner → `Callout` (ok/warning/critical); findings →
  `Card` with severity `Badge`, evidence `Kvs`, recommendation `Callout`; empty
  state when no findings.
- **State** — Runtime/Features/Plugins cards; raw `<details class="panel ...">`
  becomes a `Disclosure`.
- **Request detail** — header with back action, `METHOD /path` title, status
  `Badge`; `DetailSummary` strip (id/ip/time/source); ARIA `Tabs`
  (Overview/Waterfall/Queries/Headers/Body/Error/Replay) with the deep-link tab
  param preserved. Waterfall/TimeBreakdown restyled only: drop the `#fff` hover,
  tokenise gap hatching, remove the fixed 240px detail margin.
- **Log detail** — header + Record/Message/Fields cards + correlation link;
  loading and 404 states preserved.
- **KT** — hero gradient/glow removed → `PageHeader` (title = service name) + env
  chips + right-aligned runtime meta block; sections become consistent cards
  (project map, pipeline, plugins, routes, DB activity, span kinds, docs, SDK,
  environment) reusing primitives.
- **Docs** — responsive two-pane: ≥1024px sidebar 260–280px, stacked below; doc
  list gets a filter box + active state; content card keeps sanitized
  `Markdown`; deep links unchanged.
- **Toast** — restyled; `role="status"` / `aria-live="polite"`.

### 6.7 Accessibility bar

Landmarks + skip-to-content; `aria-current="page"` on nav; all token text
≥4.5:1; status conveyed by label + icon, not color alone; one focus-ring token;
palette focus trap + Esc; `aria-pressed` on the live-tail toggle; charts
`role="img"`; tables with `<th scope="col">` and aligned numerics; hit targets
≥28px (the 8px live-dot becomes a labelled toggle); keyboard map documented in
the status bar.

## 7. Rollout sequence

Each phase ends with `gen:debug-ui` + `verify:quick` + `test:core` green.

0. Tokens + `Icon` + primitives (built alongside existing views so nothing
   half-migrates through a broken intermediate).
1. Shell swap: `AppShell` + `Sidebar` + context bar + command palette.
2. List views: Requests/Errors, Logs, History, Routes, Jobs, Events, Clients.
3. Dashboard views: Metrics, System, Diagnostics, State.
4. Detail views: request-detail, log-detail, `detail-parts`.
5. Reference: KT, Docs, toast.
6. Delete dead CSS/classes; write the style guide; update `docs/debugbar.md`;
   extend tests.

## 8. Build & tooling

- Icons: inline SVG module, no dependency.
- Palette/tabs/disclosure: composed primitives, no dependency.
- `scripts/gen-debug-ui.ts` is unchanged.

## 9. Verification plan

- `bun run gen:debug-ui` then `bun run check:debug-ui` (artifact fresh).
- `bun run verify:quick` — typecheck, typecheck:cli, lint,
  `jsdoc:check:strict`, `check:debug-ui`, `check:maintainability`.
- `bun run test:core` — the executed-bundle smoke
  (`packages/core/test/debugbar-dashboard-runtime.test.ts`) and the router test.
- Preserve asserted strings: `IgnEx Debugbar`, `payment retry`, `GET`, `404`,
  `Live-ring records rotate out`.
- Extend the smoke to assert (a) each view renders a `PageHeader` heading, and
  (b) chrome contains no emoji.
- **Known limitation:** the running dashboard cannot be rendered in this
  environment (open SSE stream + self-signed TLS wedge headless Chromium), so
  visual sign-off is a manual `bun run dev:debug` pass against a review
  checklist (§10). This is stated rather than assumed.

## 10. Manual review checklist (for the visual pass)

- Sidebar groups, active state, rail at ≤1100px, drawer at ≤760px.
- One accent only; no gradients/glows/emoji in chrome.
- Every view shows a header with title + description + actions.
- Light and dark both legible (especially pills and `--text-faint`).
- Tables: sticky header inside the scroll container, right-aligned numerics.
- Waterfall, TimeBreakdown, query expandables, docs two-pane at 1440/1100/760px.
- Command palette keyboard flow; focus rings; live-tail toggle.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Large diff across all views regresses behaviour | Migrate in the §7 order with gates green each phase; keep data/state logic untouched |
| Generated artifact drift | Phase-gated `gen:debug-ui` + `check:debug-ui` |
| Tests assert visible strings | Explicitly preserve the list in §9 |
| No visual verification available here | Checklist-driven manual pass; no success claimed without it |
| Scope creep into behaviour | §3 non-goals; heavy interactions explicitly out |

## 12. Resolved decisions

1. **Branching:** the spec is committed to `docs-hub-debugger-docs`; all code
   lands on a new `feat/debugbar-ui-redesign` branch created from it.
2. **First-visit theme:** with no stored preference the dashboard follows
   `prefers-color-scheme`; an explicit toggle is persisted and wins thereafter.
3. **Icons:** one hand-rolled ~24-glyph inline-SVG set, used for both the
   sidebar nav and action buttons; no dependency.
