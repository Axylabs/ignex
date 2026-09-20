# Debugbar UI — design system & style guide

> The contract the debugbar dashboard is held to: one token layer, one page
> layout, one component vocabulary. Written for anyone adding or restyling a
> dashboard view, and enforced by tests rather than taste.

This is the **style guide** for the dashboard SPA under
`packages/core/src/debug/ui`. The debugbar feature itself (plugin, endpoints,
data panels) is owned by `docs/debugbar.md`; this doc owns the UI.

## Purpose

The dashboard is a dense, neutral developer tool (Chrome DevTools / Grafana
class): near-neutral surfaces, a single restrained interactive accent,
monospace numerics, compact rows, high contrast, dark-first with true light
parity. It is a dependency-free SolidJS + Tailwind SPA compiled **ahead of
time** into the committed `packages/core/src/debug/dashboard-client.gen.ts` by
`scripts/gen-debug-ui.ts` — there is no runtime build step, and the artifact is
checked for freshness by `bun run check:debug-ui`.

The design system exists so that 15 views plus two detail surfaces read as one
product and cannot drift: every color, type size, radius and surface is a
token; every repeated pattern is a component; the remaining unbounded values
are only layout dimensions. Three rules keep it honest:

1. The token layer is the only source of color and type.
2. Repeated appearance lives in a component, never in a view.
3. Tests pin the token scale, the contrast floor, and the absence of arbitrary
   typography/color.

## The normative rule

> **Utilities for layout, components for appearance, tokens for color.
> Arbitrary values only for layout dimensions — never typography or color.**

- Layout (flex/grid, gaps, padding, `max-w-[…]`, `grid-template-columns`,
  fixed chart heights) uses Tailwind utilities directly in the view.
- Appearance (borders, surfaces, radius, badges, buttons, tables) comes from a
  primitive in `ui/components/`; views do not restate card/badge/button styles.
- Color always resolves through a token (`bg-surface-1`, `text-muted`,
  `var(--cat-3)`) — never a literal like `text-[#4d9cff]` or `text-[13px]`.
- `ui/styles.css` holds tokens + `@theme` + irreducible custom CSS only
  (waterfall geometry, span-tree indent, markdown descendant typography,
  keyframes). It defines no component surfaces.

`ui/components/button.tsx` is the one documented exception to "no literal
color": the primary button derives a darker fill from `--accent` because
`--accent-fg` on raw `--accent` is only ~2.8:1. It is a `color-mix` over a
token, not a hard-coded hex.

## Tokens

Source of truth: `packages/core/src/debug/ui/styles.css` (`:root`,
`html[data-theme="light"]`, and the `@theme inline` mapping that turns tokens
into Tailwind utilities). Light theme redefines the **complete** list, not a
subset.

### Color

| Token | Role | Dark | Light |
| --- | --- | --- | --- |
| `--bg` | app canvas | `#0c0e12` | `#f6f7f9` |
| `--surface-1` | card surface | `#12151b` | `#ffffff` |
| `--surface-2` | raised surface | `#181c24` | `#f1f3f6` |
| `--surface-3` | input / track | `#1e232c` | `#e8ecf1` |
| `--border` | hairline | `#262c37` | `#dde3ea` |
| `--border-strong` | emphasized hairline | `#38404e` | `#c3ccd8` |
| `--text` | primary text | `#e6eaf0` | `#161a20` |
| `--text-muted` | secondary text | `#9aa6b6` | `#55606f` |
| `--text-faint` | tertiary text | `#7c8899` | `#6b7684` |
| `--accent` | the one interactive color (nav, focus, links, borders) | `#4d9cff` | `#1f6feb` |
| `--accent-fg` | text on an accent fill | `#ffffff` | `#ffffff` |
| `--accent-soft` | accent tint | `accent @ 14%` | `accent @ 12%` |
| `--ok` / `--warn` / `--err` / `--info` | status | `#3ddc97` / `#f5b544` / `#ff6b6b` / `#4cc9f0` | `#0f7a57` / `#8a5a00` / `#c9271b` / `#0b6f9e` |
| `--*-soft` | status tint | `status @ 14%` | `status @ 14%` |
| `--cat-1…8` | categorical data (span kinds, HTTP methods, client platforms) | blue / green / violet / amber / pink / cyan / slate / red | darkened equivalents |
| `--overlay` | one translucent surface for palette / dialog / drawer | `rgba(12,14,18,.72)` | `rgba(246,247,249,.78)` |

**Accent discipline (normative).** Accent marks interactive or active state
only — active nav, focus ring, links, the primary button, selected-row edge,
chart lines. It never decorates titles or numbers. Status uses the semantic
tokens; categories use `--cat-*`. There are no gradients, glows or accent
halos.

### Contrast floor

Every text token clears **≥ 4.5:1** on `--surface-1` in **both** themes:
`--text`, `--text-muted`, `--text-faint`. Status text (badges, callouts,
error states) also carries a **text label**, so status is never conveyed by
color alone. Solid accent fills must not place `--accent-fg` straight on raw
`--accent`; use the primary `Button`'s derived fill (≈5.3:1 dark / ≈7.9:1
light). The floor is asserted by `debug-ui-tokens.test.ts`; a token that drops
below it fails CI.

### Type

One 6-step ramp replaces the older per-view font sizes. Every number, id, path
and code sample uses `--mono` with `font-variant-numeric: tabular-nums`.

| Token | Size | Tailwind alias | Use |
| --- | --- | --- | --- |
| `--fs-xs` | 11px | `text-xs` | labels, badges, meta |
| `--fs-sm` | 12px | `text-sm` | body, table cells, buttons |
| `--fs-md` | 13px | `text-md` | inputs, dense body |
| `--fs-lg` | 15px | `text-lg` | sub-headings |
| `--fs-xl` | 20px | `text-xl` | view `h1` |
| `--fs-2xl` | 28px | `text-2xl` | hero numerics (KT) |

Line-height: tight 1.25 for headings, normal 1.5 for body.

### Spacing

Tailwind's 4px scale. Vertical rhythm comes from a **page stack**, not from
per-card margins: `AppShell` wraps the view outlet in `flex flex-col gap-4`,
and each view is a `flex flex-col gap-4` stack of `PageHeader` → `StatRow` /
`Toolbar` → cards / tables. Cards own internal `p-4`; a `pad={false}` card
owns all spacing itself (edge-to-edge table scrollers).

### Radius, elevation, motion

- **Radius** — `--radius-sm` 6px, `--radius-md` 8px, `--radius-lg` 12px, plus
  full pills for counts. No other radii.
- **Elevation** — 1px borders, not shadows. One soft `--shadow` is reserved
  for overlays (palette, toast, drawer).
- **Motion** — 120ms on color/border/background only. No card lift or hover
  glow. Kept: the `row-fresh` flash (1.6s) that makes a newly arrived trace
  visible, the live-dot pulse, and a blanket
  `@media (prefers-reduced-motion: reduce)` override that disables both.

## Component catalog

Import each primitive from its owning module (there is no barrel). One-line
contracts:

### Layout (`ui/layout/`)

| Component | Contract |
| --- | --- |
| `AppShell` | Composition root: skip link, sidebar, context bar, `<main id="view">`, status bar, palette and toast; owns global shortcuts, delegated `[data-copy]` clicks, the SSE stream and its silent-stream watchdog. |
| `Sidebar` | The grouped, collapsible nav (`full` / 56px `rail` / off-canvas `drawer`) rendered from `NAV_GROUPS`. |
| `NavItem` | One sidebar link: icon + label + optional live badge, `aria-current="page"` when active (icon-only + `aria-label`/`title` in rail mode). |
| `ContextBar` | Sticky `service / View` breadcrumb plus the global live-tail / refresh / theme / palette controls; per-view actions live in the view's `PageHeader`. |
| `CommandPalette` | `Cmd`/`Ctrl-K` `role="dialog"` fuzzy palette over the 15 views plus quick actions; focus trap, arrow/Enter/Esc, restores focus on close. |

### Primitives (`ui/components/`)

| Component | Contract |
| --- | --- |
| `Icon` | Inline-SVG chrome glyph (`IconName`, default 16px, `stroke="currentColor"`); the only icon surface. |
| `Button` | `primary` / `ghost` / `danger` / `icon` × `sm` / `md`, optional `icon` / `title` / `ariaPressed` / `dataCopy`. |
| `Badge` | `tone`-driven status/label chip (soft or solid, optional mono); domain wrappers (`MethodBadge`, `StatusBadge`, `KindBadge`, `LevelBadge`, `SqlBadge`, `Chip`, `CountChip`, `DirPill`) map values onto tones/categorical tokens. |
| `Card` | Titled token surface (`title` / `description` / `actions`), `pad={false}` for edge-to-edge content; `CardGrid` is an auto-fill grid at a caller-chosen minimum width. |
| `Callout` | Tone-coloured advisory banner (`ok` / `warn` / `err` / `info`) with a default tone icon. |
| `Disclosure` | Native `<details>` collapsible with an icon chevron and optional count badge. |
| `PageHeader` | The view's single `<h1>` plus description, actions and optional back/badge — the one header every view renders. |
| `Toolbar` | Filter/action strip above a table or grid; `sticky` pins it under the context bar. |
| `Stat` | Numeric tile (mono tabular value; tone colours the value only, never the tile); `StatRow` / `StatGrid` lay tiles out responsively. |
| `DataTable` | Dense, scroll-contained table with a sticky `<thead>` inside the scroller, `align` columns right-aligned/tabular, and `empty` / `loading` slots. |
| `Tabs` | ARIA `tablist` with roving tabindex; Arrow/Home/End move selection and focus (WAI-ARIA tabs pattern). |
| `Field` / `Select` / `SearchInput` | Labelled field wrapper, token-styled native select, and the search box (honours `id="search"` so `/` focuses it). |
| `EmptyState` / `LoadingState` / `ErrorState` | The three non-data renders (`role="status"` + `aria-busy` for loading, `role="alert"` + optional retry for errors). |
| `Kvs` | Key/value definition grid (`headerRows` adapts a headers record). |
| `Chart` | Fixed-height canvas sparkline with `role="img"` + `aria-label`, current/min/max repeated as text beside it. |
| `BarRow` / `BarTrack` | Horizontal bar geometry for per-kind totals. |

### Detail geometry (`ui/components/detail-parts.tsx`)

The waterfall, time breakdown, query table and body/error blocks are genuinely
2-D geometry and stay as focused components backed by the irreducible CSS in
`styles.css` (`.wf-*`, `.bd-*`, `.tree`, `pre.mini` / `pre.body`):
`TimeBreakdown`, `Waterfall`, `QueriesTable`, `BodyPanel`.

## Icons

Chrome icons are a hand-rolled ~37-glyph inline-SVG set in
`ui/components/icon.tsx` — no icon dependency, no emoji/glyph chrome. Every
view, nav entry and button draws from `IconName`; `iconForView(id)` maps the
registry ids, `iconForCommand` maps palette commands. Add a glyph by extending
the `IconName` union and its `PATHS` entry, then update the icon guard.

Data-typographic marks are **not** chrome and stay as text: `↳` (wire
round-trip), `→` (target/relation), `…` (idle/missing), `—` (empty value), and
the `⌘K` keyboard hint.

## Accessibility bar

- Landmarks + a skip-to-content link targeting `<main id="view">`.
- `aria-current="page"` on the active nav item; rail mode keeps an
  `aria-label`.
- All token text ≥ 4.5:1; status always carries a label (never color alone).
- One focus ring (`outline-2 outline-accent outline-offset-2`) on every
  interactive control; the palette traps Tab and closes on Esc.
- `aria-pressed` on the live-tail toggle (icon swaps play/pause); charts are
  `role="img"` with a text current/min/max; tables use `<th scope="col">` and
  right-align tabular numerics.
- Hit targets ≥ 28px (the toolbar buttons are `h-7`/`h-8`); the live-tail
  control is a labelled button, not an 8px dot.
- `prefers-reduced-motion` disables transitions and animations; the keyboard
  map is documented in the status bar (`0–9`, `/`, `r`, `t`, `⌘K`).

## How to add a view

1. **Registry entry** — add `{ id, label, key, domain, component }` to `VIEWS`
   in `ui/views/registry.tsx`; add the id to the router's `KNOWN_VIEWS` in
   `ui/router.ts`.
2. **Nav** — add the id to the right group in `ui/nav.ts` (`GROUP_ORDER`) and
   map an icon in `VIEW_ICONS`.
3. **Module** — create `ui/views/<id>.tsx`. Start it with `PageHeader`
   (title + description + actions) and compose `StatRow` / `Toolbar` /
   `DataTable` / `Card` / states from `ui/components/`. Fetch through
   `ui/api.ts`; never hand-roll a card, badge or table.
4. **Page archetype** — pick one and match it: *List/monitor* (`PageHeader` →
   `StatRow` → `Toolbar` → `DataTable` → states), *Dashboard* (`PageHeader` →
   `StatRow` → card grid / callouts), *Detail* (`PageHeader` → summary strip →
   `Tabs` → panels), *Reference* (`PageHeader`/hero → sectioned cards).
5. **Tests** — the nav guard (`debug-ui-nav.test.ts`) pins registry↔nav sync,
   and the executed-bundle smoke
   (`debugbar-dashboard-runtime.test.ts`) mounts every view and asserts a
   non-empty `PageHeader <h1>` and emoji-free chrome.
6. **Regenerate** — `bun run gen:debug-ui`, then run `bun run verify:quick`
   and `bun run test:core`.

## Running the guards

The design system is enforced by `packages/core/test/debug-ui-tokens.test.ts`
and friends:

```sh
# token scale, both-theme contrast floor, no removed tokens,
# no arbitrary typography/color in ui/ sources
bunx vitest run packages/core/test/debug-ui-tokens.test.ts

# executed-bundle smoke: every view renders an <h1>, no emoji chrome,
# nav/palette/icon/tabs/router/theme guards
bunx vitest run packages/core/test/debug-ui-*.test.ts \
  packages/core/test/debugbar-dashboard-runtime.test.ts

# the whole core suite + the quick gate
bun run test:core && bun run verify:quick
```

`bun run verify:quick` includes `check:debug-ui` (artifact freshness) and
`check:maintainability`; edit `ui/`, then **always** run `bun run
gen:debug-ui` before committing or the freshness check fails.

## Manual review checklist

The dashboard cannot be rendered headlessly here (an open SSE stream + TLS
wedge headless Chromium), so a visual pass is a manual `bun run dev:debug`
against this list — stated, not assumed. Check: sidebar groups and active
state, the ≤1100px rail and ≤760px drawer; one accent only, no
gradients/glows/emoji; every view shows a header with title + description +
actions; light and dark both legible (especially pills and `--text-faint`);
tables keep their sticky header inside the scroll container with right-aligned
numerics; the waterfall, time breakdown, query expandables and the docs
two-pane at 1440/1100/760px; and the palette keyboard flow, focus rings and
live-tail toggle.
