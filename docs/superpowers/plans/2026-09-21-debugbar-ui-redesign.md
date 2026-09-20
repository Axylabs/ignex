# Debugbar Dashboard UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the debugbar dashboard's design system and every view's layout so it reads as a dense, neutral developer tool with one documented style guide, a grouped sidebar, and consistent page structure.

**Architecture:** A token-first rewrite of `packages/core/src/debug/ui/styles.css` (tokens + `@theme inline` only, Tailwind utilities everywhere else) plus a set of shared SolidJS layout primitives under `ui/components/`. The shell moves to `AppShell` + a grouped `Sidebar` + a command palette; each view is migrated onto `PageHeader`/`Toolbar`/`DataTable`/`Card`/`Badge`/state primitives. The AOT build (`scripts/gen-debug-ui.ts`) is unchanged.

**Tech Stack:** Bun 1.4+, SolidJS, Tailwind CSS v4 (`@tailwindcss/cli`), vitest + happy-dom. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-21-debugbar-ui-redesign-design.md`

## Global Constraints

- **Bun-first, no new dependency.** Icons are inline SVG; palette/tabs are composed primitives (spec §6.4).
- **Tailwind-first.** Utilities for layout; tokens for color; arbitrary values only for layout dimensions (grid templates, max-widths, fixed chart heights), never for typography or color (spec §2/§6.4).
- **Every new file under `ui/` starts with a `@fileoverview` JSDoc block; every export has JSDoc** — `jsdoc:check:strict` is a gate.
- **Every new export must be consumed** — `check:dead` (knip) is a gate.
- **Do not change** the wire API, endpoints, data shapes, routing semantics, or `scripts/gen-debug-ui.ts` (spec §3).
- **Preserve** the assertion strings in `packages/core/test/debugbar-dashboard-runtime.test.ts`: `IgnEx Debugbar`, `payment retry`, `GET`, `404`, `Live-ring records rotate out` (spec §9).
- **Artifact freshness.** After any change under `ui/`, run `bun run gen:debug-ui` and commit `packages/core/src/debug/dashboard-client.gen.ts` (spec §9).
- **Per-phase gate:** `bun run verify:quick && bun run test:core` must pass before moving to the next phase (spec §7).
- **Fonts:** `--font` (system sans) and `--mono`; all numerics/ids/paths use mono + `tabular-nums`.
- **Contrast floor:** every text token ≥ 4.5:1 against `--surface-1` in both themes (spec §6.1/§6.7).

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `packages/core/src/debug/ui/tokens.css` | *Not created* — tokens stay in `styles.css` (Tailwind CLI input is a single file). |
| `packages/core/src/debug/ui/components/icon.tsx` | `IconName` union + `<Icon>` inline-SVG component |
| `packages/core/src/debug/ui/components/button.tsx` | `Button` (primary/ghost/danger/icon × sm/md) |
| `packages/core/src/debug/ui/components/badge.tsx` | `Badge` unified tone-driven pill + `Chip` |
| `packages/core/src/debug/ui/components/card.tsx` | `Card`, `Panel` (re-export), `CardGrid`, `Callout`, `Disclosure` |
| `packages/core/src/debug/ui/components/stats.tsx` | `Stat`, `StatRow`, `StatGrid` |
| `packages/core/src/debug/ui/components/page.tsx` | `PageHeader`, `Toolbar` |
| `packages/core/src/debug/ui/components/table.tsx` | `DataTable` (+ empty/loading/error slots) |
| `packages/core/src/debug/ui/components/states.tsx` | `EmptyState`, `LoadingState`, `ErrorState` |
| `packages/core/src/debug/ui/components/fields.tsx` | `Field`, `Select`, `SearchInput` |
| `packages/core/src/debug/ui/components/tabs.tsx` | ARIA `Tabs` |
| `packages/core/src/debug/ui/components/kvs.tsx` | `Kvs`, `headerRows` (moved from `widgets.tsx`) |
| `packages/core/src/debug/ui/components/chart.tsx` | `Chart` (canvas + a11y) for the System view |
| `packages/core/src/debug/ui/layout/shell.tsx` | `AppShell` |
| `packages/core/src/debug/ui/layout/sidebar.tsx` | `Sidebar`, `NavItem` |
| `packages/core/src/debug/ui/layout/context-bar.tsx` | `ContextBar` |
| `packages/core/src/debug/ui/palette.ts` | Pure command model + fuzzy filter |
| `packages/core/src/debug/ui/layout/command-palette.tsx` | Palette component |
| `packages/core/src/debug/ui/nav.ts` | Grouped navigation model |
| `packages/core/test/debug-ui-tokens.test.ts` | Style-guide guard (scale + contrast) |
| `packages/core/test/debug-ui-theme.test.ts` | Theme resolution unit tests |
| `packages/core/test/debug-ui-nav.test.ts` | Nav grouping unit tests |
| `packages/core/test/debug-ui-palette.test.ts` | Palette fuzzy-filter unit tests |
| `docs/debugbar-ui.md` | The style guide (owned by `docs/README.md`) |

**Modify**

| File | Change |
|---|---|
| `packages/core/src/debug/ui/styles.css` | Tokens + `@theme` + irreducible custom styles only |
| `packages/core/src/debug/ui/app.tsx` | Becomes a thin composition of `AppShell` |
| `packages/core/src/debug/ui/theme.ts` | `prefers-color-scheme` on first visit; `initTheme()` |
| `packages/core/src/debug/ui/components/widgets.tsx` | Re-exports moved primitives; keeps `BarRow`/`BarTrack`/`rowKeyHandler` |
| `packages/core/src/debug/ui/components/detail-parts.tsx` | Restyle on primitives |
| `packages/core/src/debug/ui/views/*.tsx` | All 17 surfaces migrated |
| `packages/core/src/debug/ui/toast.tsx` | Restyle + `aria-live` |
| `packages/core/test/debugbar-dashboard-runtime.test.ts` | Add heading + no-emoji assertions |
| `docs/README.md` | Register `debugbar-ui.md` |
| `docs/debugbar.md` | UI tour + wiring bullets |
| `packages/core/src/debug/dashboard-client.gen.ts` | Regenerated |

**Delete (dead, confirmed referenced-nowhere or defined-nowhere)** — spec §6.4/§5 #16: `.ok-text`, `.brand-sub`, `pre.codeblock`, `.topbar`, `.statusbar`, `.sub`, `.toast.show`.

---

# Phase 0 — Foundations

## Task 1: Token system + style-guide guard test

**Files:**
- Modify: `packages/core/src/debug/ui/styles.css` (replace the `:root`, `html[data-theme="light"]`, and `@theme inline` blocks; delete every other rule — later tasks re-add only the irreducible ones)
- Create: `packages/core/test/debug-ui-tokens.test.ts`

**Interfaces:**
- Produces: CSS custom properties `--bg --surface-1 --surface-2 --surface-3 --border --border-strong --text --text-muted --text-faint --accent --accent-fg --accent-soft --ok/--ok-soft --warn/--warn-soft --err/--err-soft --info/--info-soft --overlay --cat-1..8 --fs-xs/sm/md/lg/xl/2xl --font --mono --shadow --sidebar-w --sidebar-w-rail --context-h`; Tailwind utilities `bg-bg bg-surface-1 bg-surface-2 bg-surface-3 border-line border-line-strong text-ink text-muted text-faint bg-accent text-accent-fg bg-ok… bg-overlay text-xs…2xl`.

- [ ] **Step 1: Write the failing guard test**

`packages/core/test/debug-ui-tokens.test.ts`:

```ts
/**
 * @fileoverview Style-guide guard — asserts the token layer honours the
 * documented scale and contrast floor, so the design system cannot drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  join(import.meta.dir, "../src/debug/ui/styles.css"),
  "utf8",
);
const RAMP = ["11px", "12px", "13px", "15px", "20px", "28px"];

/** Extract the declarations of a selector block (first match). */
const block = (selector: string): string => {
  const i = CSS.indexOf(selector);
  if (i < 0) throw new Error(`selector not found: ${selector}`);
  return CSS.slice(i, CSS.indexOf("}", i));
};

/** Parse `--name: value` pairs from a block body. */
const vars = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
};

/** WCAG relative luminance of a #rrggbb color. */
const lum = (hex: string): number => {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};

/** WCAG contrast ratio between two #rrggbb colors. */
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("debugbar design tokens", () => {
  it("exposes exactly the documented 6-step type ramp", () => {
    const v = vars(block(":root"));
    expect(
      ["--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl"].map((k) => v.get(k)),
    ).toEqual(RAMP);
  });

  it("meets 4.5:1 for all three text levels in both themes", () => {
    for (const sel of [":root", 'html[data-theme="light"]']) {
      const v = vars(block(sel));
      for (const [fg, bg] of [
        ["--text", "--surface-1"],
        ["--text-muted", "--surface-1"],
        ["--text-faint", "--surface-1"],
      ] as const) {
        const ratio = contrast(v.get(fg)!, v.get(bg)!);
        expect(ratio, `${sel} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("every @theme color mapping points at a defined token", () => {
    const theme = block("@theme inline");
    const defs = new Set([...vars(block(":root")).keys(), ...vars(block('html[data-theme="light"]')).keys()]);
    for (const m of theme.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)) {
      expect(defs.has(m[1] as string), `undefined token ${m[1]}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run packages/core/test/debug-ui-tokens.test.ts`
Expected: FAIL — off-ramp sizes (9.5/10/10.5/…) and `--text-faint` contrast ≈ 2.8.

- [ ] **Step 3: Replace the token blocks in `styles.css`**

Replace lines up to the end of the old `@theme inline` / `html[data-theme="light"]` blocks with:

```css
/*
 * IgnEx Debugbar dashboard — Tailwind input.
 * Tokens + @theme only. Components are Tailwind utilities in `ui/`.
 * Build: scripts/gen-debug-ui.ts (bun run gen:debug-ui).
 */
@import "tailwindcss";
@source "./**/*.{ts,tsx}";
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));

@theme inline {
  --color-bg: var(--bg);
  --color-surface-1: var(--surface-1);
  --color-surface-2: var(--surface-2);
  --color-surface-3: var(--surface-3);
  --color-line: var(--border);
  --color-line-strong: var(--border-strong);
  --color-ink: var(--text);
  --color-muted: var(--text-muted);
  --color-faint: var(--text-faint);
  --color-accent: var(--accent);
  --color-accent-fg: var(--accent-fg);
  --color-accent-soft: var(--accent-soft);
  --color-ok: var(--ok);
  --color-ok-soft: var(--ok-soft);
  --color-warn: var(--warn);
  --color-warn-soft: var(--warn-soft);
  --color-err: var(--err);
  --color-err-soft: var(--err-soft);
  --color-info: var(--info);
  --color-info-soft: var(--info-soft);
  --color-overlay: var(--overlay);
  --font-sans: var(--font);
  --font-mono: var(--mono);
  --text-xs: var(--fs-xs);
  --text-sm: var(--fs-sm);
  --text-md: var(--fs-md);
  --text-lg: var(--fs-lg);
  --text-xl: var(--fs-xl);
  --text-2xl: var(--fs-2xl);
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --shadow-overlay: var(--shadow);
}

:root {
  color-scheme: dark;
  --bg: #0c0e12;
  --surface-1: #12151b;
  --surface-2: #181c24;
  --surface-3: #1e232c;
  --border: #262c37;
  --border-strong: #38404e;
  --text: #e6eaf0;
  --text-muted: #9aa6b6;
  --text-faint: #7c8899;
  --accent: #4d9cff;
  --accent-fg: #ffffff;
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --ok: #3ddc97;
  --ok-soft: color-mix(in srgb, var(--ok) 14%, transparent);
  --warn: #f5b544;
  --warn-soft: color-mix(in srgb, var(--warn) 14%, transparent);
  --err: #ff6b6b;
  --err-soft: color-mix(in srgb, var(--err) 14%, transparent);
  --info: #4cc9f0;
  --info-soft: color-mix(in srgb, var(--info) 14%, transparent);
  --overlay: rgba(12, 14, 18, 0.72);
  --cat-1: #4d9cff;
  --cat-2: #3ddc97;
  --cat-3: #b69cff;
  --cat-4: #f5b544;
  --cat-5: #ff8fa3;
  --cat-6: #4cc9f0;
  --cat-7: #8a9eb0;
  --cat-8: #ff6b6b;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;
  --fs-lg: 15px;
  --fs-xl: 20px;
  --fs-2xl: 28px;
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  --sidebar-w: 220px;
  --sidebar-w-rail: 56px;
  --context-h: 48px;
}
```

> Executor note: the token block above is authoritative; ensure `--cat-7` is `#8a9eb0`.

```css
html[data-theme="light"] {
  color-scheme: light;
  --bg: #f6f7f9;
  --surface-1: #ffffff;
  --surface-2: #f1f3f6;
  --surface-3: #e8ecf1;
  --border: #dde3ea;
  --border-strong: #c3ccd8;
  --text: #161a20;
  --text-muted: #55606f;
  --text-faint: #6b7684;
  --accent: #1f6feb;
  --accent-fg: #ffffff;
  --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
  --ok: #0f7a57;
  --warn: #8a5a00;
  --err: #c9271b;
  --info: #0b6f9e;
  --overlay: rgba(246, 247, 249, 0.78);
  --shadow: 0 12px 32px rgba(22, 26, 32, 0.14);
  --cat-1: #1f6feb;
  --cat-2: #0f7a57;
  --cat-3: #6a4fd0;
  --cat-4: #8a5a00;
  --cat-5: #c02a5a;
  --cat-6: #0b6f9e;
  --cat-7: #64707e;
  --cat-8: #c9271b;
}
```

Delete **every other rule** in the file for now (base, panels, pills, tables, waterfall, KT, animations, media queries). Tasks 2–9 and the view tasks re-add only what is irreducible; everything else becomes Tailwind utilities.

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `bunx vitest run packages/core/test/debug-ui-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Regenerate + gate + commit**

```bash
bun run gen:debug-ui
bun run verify:quick
git add packages/core/src/debug/ui/styles.css packages/core/test/debug-ui-tokens.test.ts packages/core/src/debug/dashboard-client.gen.ts
git commit -m "refactor(debug-ui): token-first stylesheet with scale + contrast guard"
```

## Task 2: Inline-SVG icon set

**Files:**
- Create: `packages/core/src/debug/ui/components/icon.tsx`
- Modify: `packages/core/src/debug/ui/components/widgets.tsx` (re-export `Icon`)

**Interfaces:**
- Produces: `type IconName`, `Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element`.

Icon names required by the spec's inventory (replace the emoji/glyph chrome): `menu chevron-left chevron-down chevron-right search close refresh pause play sun moon copy external-link trash plus alert check x-circle database file-text book list activity cpu stethoscope layers briefcase route radio package sparkles info bolt filter clock terminal arrow-right`.

- [ ] **Step 1: Write the component**

`components/icon.tsx` — 24×24 viewBox, `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`, `width/height` = `size ?? 16`, `aria-hidden="true"` (labels come from the control). Provide real path data for each name. Two examples of the required style:

```tsx
/**
 * @fileoverview Inline-SVG icon set — replaces emoji/glyph chrome with a
 * dependency-free monochrome set that inherits `currentColor`.
 */
import type { JSX } from "solid-js";

/** Every icon the dashboard chrome uses. */
export type IconName =
  | "menu" | "chevron-left" | "chevron-down" | "chevron-right"
  | "search" | "close" | "refresh" | "pause" | "play"
  | "sun" | "moon" | "copy" | "external-link" | "trash" | "plus"
  | "alert" | "check" | "x-circle" | "database" | "file-text" | "book"
  | "list" | "activity" | "cpu" | "stethoscope" | "layers" | "briefcase"
  | "route" | "radio" | "package" | "sparkles" | "info" | "bolt" | "filter"
  | "clock" | "terminal" | "arrow-right";

/** 24×24 stroke path data per icon. */
const PATHS: Record<IconName, string> = {
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-down": "M6 9l6 6 6-6",
  refresh: "M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16M4 20v-4h4",
  // …remaining names use the same 24×24 / 1.75-stroke convention.
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
```

- [ ] **Step 2: Typecheck the union is exhaustive**

Run: `bun run typecheck`
Expected: PASS (a missing `PATHS` key fails here).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/debug/ui/components/icon.tsx
git commit -m "feat(debug-ui): inline-SVG icon set"
```

## Task 3: Core primitives — buttons, badges, fields

**Files:**
- Create: `packages/core/src/debug/ui/components/button.tsx`, `components/badge.tsx`, `components/fields.tsx`
- Modify: `packages/core/src/debug/ui/components/widgets.tsx` (re-export)

**Interfaces:**
- Produces:
  - `Button(props: { variant?: "primary"|"ghost"|"danger"; size?: "sm"|"md"; icon?: IconName; label?: string; disabled?: boolean; title?: string; onClick?: (ev: MouseEvent) => void; dataCopy?: string; children?: JSX.Element }): JSX.Element`
  - `Badge(props: { tone: "ok"|"warn"|"err"|"info"|"neutral"; variant?: "solid"|"soft"; mono?: boolean; children: JSX.Element }): JSX.Element`
  - `MethodBadge(props: { method: string }): JSX.Element`, `StatusBadge(props: { status: number }): JSX.Element`, `KindBadge(props: { kind: string }): JSX.Element`, `LevelBadge(props: { level: string }): JSX.Element`, `SqlBadge(props: { action: string | null | undefined }): JSX.Element`
  - `Chip(props: { children?: JSX.Element; class?: string; title?: string; dataCopy?: string }): JSX.Element`
  - `Field(props: { label: string; children: JSX.Element }): JSX.Element`, `Select(props: SelectHTMLAttributes & { children: JSX.Element }): JSX.Element`, `SearchInput(props: { id?: string; placeholder?: string; value?: string; mono?: boolean; onInput?: (value: string) => void }): JSX.Element`

- [ ] **Step 1: Implement `button.tsx`**

Class map (Tailwind, tokens only):

```
base: "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
sm:   "h-7 px-2"
md:   "h-8 px-3"
primary: "bg-accent text-accent-fg hover:brightness-110"
ghost:   "border border-line text-muted hover:bg-surface-2 hover:text-ink hover:border-line-strong"
danger:  "border border-line text-err hover:bg-err-soft hover:border-err"
icon:    "h-7 w-7 border border-line text-muted hover:bg-surface-2 hover:text-ink"
```

Render `<button type="button" class=… onClick onDisabled? disabled title data-copy>`, and when `icon` is set render `<Icon name={icon} />` before `label`/`children`. `dataCopy` maps to `data-copy` (the shell's delegated copy listener reads it).

- [ ] **Step 2: Implement `badge.tsx`**

One component; tone → token, `soft` (default) uses `bg-<tone>-soft text-<tone> border border-<tone>/35`, `solid` uses `bg-<tone> text-bg`. `mono` adds `font-mono tabular-nums`. `neutral` = `bg-surface-2 text-muted border-line`. The five typed wrappers map domain values to tone/text using the existing `format.ts` helpers (`statusCls`→tone, `methodCls`, `kindColor`, `sqlPillCls`). `KindBadge` sets `color: kindColor(kind)` inline. **`StatusBadge` renders the numeric status plus a text label** so status is never color-only (spec §6.7).

- [ ] **Step 3: Implement `fields.tsx`**

`Field` = `<label class="flex flex-col gap-1 text-xs text-muted"><span>{label}</span>{children}</label>`. `SearchInput` = `<input type="text" class="h-8 min-w-0 rounded-md border border-line bg-surface-3 px-2.5 text-md text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 font-mono?"/>` and forwards `id` (so `#search` survives) and `onInput={(ev) => props.onInput?.(ev.currentTarget.value)}`. `Select` = same box with `h-8` and `text-md`.

- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck && bun run lint
git add packages/core/src/debug/ui/components/{button,badge,fields}.tsx packages/core/src/debug/ui/components/widgets.tsx
git commit -m "feat(debug-ui): button, badge and field primitives"
```

## Task 4: Core primitives — card, stats, states, page, table, tabs, kvs, disclosure, callout

**Files:**
- Create: `components/card.tsx`, `components/stats.tsx`, `components/states.tsx`, `components/page.tsx`, `components/table.tsx`, `components/tabs.tsx`, `components/kvs.tsx`
- Modify: `components/widgets.tsx` (re-export; keep `BarRow`/`BarTrack`/`rowKeyHandler`)

**Interfaces:**
- Produces:
  - `Card(props: { title?: string; description?: string; actions?: JSX.Element; pad?: boolean; children?: JSX.Element }): JSX.Element`; `Panel` kept as an alias of `Card` so untouched call-sites compile.
  - `CardGrid(props: { min: number; children: JSX.Element }): JSX.Element` → `grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(<min>px,1fr))]`
  - `Callout(props: { tone: "ok"|"warn"|"err"|"info"; title: string; children?: JSX.Element; icon?: IconName }): JSX.Element`
  - `Disclosure(props: { summary: string; count?: number; children: JSX.Element }): JSX.Element` (native `<details>`, `<summary>` styled, chevron via `Icon`)
  - `Stat(props: { value: unknown; label: string; sub?: string; tone?: "ok"|"warn"|"err"|"accent" }): JSX.Element`, `StatRow`, `StatGrid(props: { children: JSX.Element })`
  - `EmptyState`, `LoadingState(props: { rows?: number })`, `ErrorState(props: { message: string; hint?: string; onRetry?: () => void })`
  - `PageHeader(props: { title: string; description?: string; actions?: JSX.Element; back?: () => void; badge?: JSX.Element }): JSX.Element`
  - `Toolbar(props: { children: JSX.Element; sticky?: boolean }): JSX.Element`
  - `DataTable<T>(props: { columns: string[]; rows: T[]; rowKey: (row: T) => string; render: (row: T) => JSX.Element; onRowClick?: (row: T) => void; empty?: JSX.Element; loading?: boolean; align?: number[]; label: string }): JSX.Element`
  - `Tabs(props: { tabs: { id: string; label: string }[]; active: string; onSelect: (id: string) => void }): JSX.Element`
  - `Kvs`, `KvsRow`, `headerRows` (moved verbatim from `widgets.tsx`)

- [ ] **Step 1: Implement the primitives**

Required details:
- `PageHeader` renders `<header class="mb-4 flex items-start gap-3"><...><h1 class="text-xl font-semibold tracking-tight text-ink">{title}</h1>` + optional `<p class="text-sm text-muted">{description}</p>` + `actions` pushed right via `ml-auto`. `back` renders `<Button variant="icon" icon="chevron-left" title="Back" />`.
- `Card` = `<section class="rounded-lg border border-line bg-surface-1 p-4">` + optional head (`h2` at `text-xs font-semibold uppercase tracking-wide text-muted`). No `margin-bottom`; vertical rhythm comes from a page stack (see `AppShell` main `flex flex-col gap-4`).
- `Stat` = `<div class="rounded-lg border border-line bg-surface-1 px-3.5 py-3"><div class="font-mono text-xl font-semibold tabular-nums">{value}</div><div class="mt-0.5 text-xs uppercase tracking-wide text-muted">{label}</div>{sub}</div>`. Tone colors only the value (`text-ok|warn|err|accent`). **No `::after` halo.**
- `DataTable` wraps the table in `<div class="overflow-auto">` so `thead th` uses `sticky top-0` **inside that scroller** (fixes spec §5 #10). Numeric column indices in `align` get `text-right tabular-nums`. `<th scope="col">`. Rows call `onRowClick` and are keyboard-activatable via `rowKeyHandler`; hover/selected uses the accent edge (`hover:bg-surface-2`, `data-selected` → `shadow-[inset_2px_0_0_var(--accent)]`).
- `Tabs` renders `role="tablist"`, buttons with `role="tab"`, `aria-selected`, `id`, `aria-controls`; the page renders `role="tabpanel"`.
- `Callout` replaces `.verdict`/`.kt-callout`/`.f-reco`: `rounded-lg border px-4 py-3` with tone border/soft bg and an `Icon`.

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add packages/core/src/debug/ui/components/*.tsx
git commit -m "feat(debug-ui): layout primitives (card, stats, states, page, table, tabs)"
```

## Task 5: Grouped navigation model

**Files:**
- Create: `packages/core/src/debug/ui/nav.ts`, `packages/core/test/debug-ui-nav.test.ts`

**Interfaces:**
- Consumes: `VIEWS`, `ViewDef` from `views/registry.tsx`.
- Produces: `interface NavGroup { id: string; label: string | null; items: ViewDef[] }`, `NAV_GROUPS: NavGroup[]`, `navGroups(views: ViewDef[]): NavGroup[]`, `iconForView(id: string): IconName`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @fileoverview Grouped-navigation model tests.
 */
import { describe, expect, it } from "vitest";
import { navGroups } from "../src/debug/ui/nav";

const v = (id: string) => ({ id, label: id, key: "", domain: null, component: () => null }) as never;

describe("navGroups", () => {
  it("partitions known views into four ordered groups", () => {
    const groups = navGroups([
      v("requests"), v("errors"), v("logs"), v("history"), v("routes"),
      v("metrics"), v("system"), v("diagnostics"), v("state"), v("jobs"),
      v("events"), v("clients"), v("kt"), v("docs"), v("ai"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Observe", "Runtime", "Integrations", "Reference"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["requests", "errors", "logs", "history", "routes"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["metrics", "system", "diagnostics", "state", "jobs"]);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(["events", "clients"]);
    expect(groups[3]!.items.map((i) => i.id)).toEqual(["kt", "docs", "ai"]);
  });

  it("drops groups with no present views", () => {
    expect(navGroups([v("requests")]).map((g) => g.id)).toEqual(["observe"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run packages/core/test/debug-ui-nav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `nav.ts`**

`GROUP_ORDER = [{id:"observe",label:"Observe",ids:[...]} …]`, `navGroups` filters each group's ids against the passed views preserving group order and dropping empties, `iconForView` maps view id → `IconName` (requests→list, errors→alert, logs→terminal, history→clock, metrics→activity, system→cpu, diagnostics→stethoscope, state→layers, jobs→briefcase, events→radio, clients→package, kt→book, docs→file-text, ai→sparkles).

- [ ] **Step 4: Run test (PASS) + commit**

```bash
bunx vitest run packages/core/test/debug-ui-nav.test.ts
git add packages/core/src/debug/ui/nav.ts packages/core/test/debug-ui-nav.test.ts
git commit -m "feat(debug-ui): grouped navigation model"
```

## Task 6: First-visit theme resolution

**Files:**
- Modify: `packages/core/src/debug/ui/theme.ts`
- Create: `packages/core/test/debug-ui-theme.test.ts`

**Interfaces:**
- Produces: `resolveInitialTheme(stored: string | null, prefersLight: boolean): "dark" | "light"`, `initTheme(): void` (applies the resolved theme to `<html data-theme>` once at boot), keeps existing `toggleTheme()`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @fileoverview Theme resolution — stored choice wins, else OS preference.
 */
import { describe, expect, it } from "vitest";
import { resolveInitialTheme } from "../src/debug/ui/theme";

describe("resolveInitialTheme", () => {
  it("honours a stored choice over the OS", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
  });
  it("follows the OS when nothing is stored", () => {
    expect(resolveInitialTheme(null, true)).toBe("light");
    expect(resolveInitialTheme(null, false)).toBe("dark");
  });
  it("ignores junk values", () => {
    expect(resolveInitialTheme("banana", true)).toBe("light");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run packages/core/test/debug-ui-theme.test.ts`
Expected: FAIL — `resolveInitialTheme` not exported.

- [ ] **Step 3: Implement**

Add the pure `resolveInitialTheme`; make the module-level initial signal use it with `localStorage` + `window.matchMedia("(prefers-color-scheme: light)").matches`; add `initTheme()` that sets `document.documentElement.dataset.theme` to the resolved value. `toggleTheme` and persistence stay as-is. Keep `getTheme` if later tasks need it.

- [ ] **Step 4: Run test (PASS), then commit**

```bash
bunx vitest run packages/core/test/debug-ui-theme.test.ts
git add packages/core/src/debug/ui/theme.ts packages/core/test/debug-ui-theme.test.ts
git commit -m "feat(debug-ui): follow prefers-color-scheme on first visit"
```

## Task 7: Command model + fuzzy filter

**Files:**
- Create: `packages/core/src/debug/ui/palette.ts`, `packages/core/test/debug-ui-palette.test.ts`

**Interfaces:**
- Produces: `interface Command { id: string; label: string; group: string; run: () => void }`, `buildCommands(deps: { navigate: (view: string, id?: string) => void; toggleTheme: () => void; refresh: () => void; togglePause: () => void }): Command[]`, `fuzzyScore(query: string, text: string): number`, `filterCommands(cmds: Command[], query: string): Command[]`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * @fileoverview Command-palette pure-logic tests.
 */
import { describe, expect, it } from "vitest";
import { filterCommands, fuzzyScore, type Command } from "../src/debug/ui/palette";

const c = (label: string): Command => ({ id: label, label, group: "Views", run: () => {} });

describe("filterCommands", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands([c("Requests"), c("Logs")], "").map((x) => x.label)).toEqual(["Requests", "Logs"]);
  });
  it("matches subsequences case-insensitively", () => {
    expect(filterCommands([c("Diagnostics"), c("Docs")], "dcs").map((x) => x.label)).toEqual(["Docs", "Diagnostics"]);
  });
  it("drops non-matches", () => {
    expect(filterCommands([c("Requests")], "zzz")).toEqual([]);
  });
});

describe("fuzzyScore", () => {
  it("scores exact prefixes highest", () => {
    expect(fuzzyScore("req", "Requests")).toBeGreaterThan(fuzzyScore("req", "ErroReQuest"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: implement**:

`fuzzyScore` returns `-Infinity` when the query is not a subsequence; otherwise sums per-character weights (word-boundary bonus, contiguous-run bonus, prefix bonus, `-index` penalty). `filterCommands` scores, drops `-Infinity`, sorts descending then by label. `buildCommands` returns the 15 view commands (group "Views", using `NAV_GROUPS` for order) plus "Refresh", "Toggle live tail", "Toggle theme" (group "Actions"), plus "Open request by id" / "Open log by id" / "Open doc by path" (group "Go to") which prompt inline. `run` closures capture `deps`.

- [ ] **Step 4: Run (PASS) + commit**

```bash
bunx vitest run packages/core/test/debug-ui-palette.test.ts
git add packages/core/src/debug/ui/palette.ts packages/core/test/debug-ui-palette.test.ts
git commit -m "feat(debug-ui): command-palette model and fuzzy filter"
```

---

# Phase 1 — Shell

## Task 8: AppShell, Sidebar, ContextBar

**Files:**
- Create: `layout/shell.tsx`, `layout/sidebar.tsx`, `layout/context-bar.tsx`
- Modify: `app.tsx`

**Interfaces:**
- Consumes: `NAV_GROUPS`, `Icon`, `Button`, `PageHeader` (views render their own), `toggleTheme`, `paused`/`setPaused`, `pushPulse`.
- Produces: `AppShell(props: { children: JSX.Element }): JSX.Element`.

- [ ] **Step 1: Implement `sidebar.tsx`**

`<aside class="sticky top-0 h-dvh shrink-0 border-r border-line bg-surface-1 transition-[width] w-(--sidebar-w) …">`, `nav aria-label="Debugbar sections"`, `NAV_GROUPS` → `<div role="group"><h2 class="text-xs uppercase … text-faint">{label}</h2>` + `For` items → `NavItem`. `NavItem` = `<a href={"#/"+id} aria-current={active ? "page" : undefined} class="…">` with `Icon` + label + optional badge. Width driven by a signal: full / rail (`--sidebar-w-rail`, icon-only, `title` + `aria-label`) / hidden (drawer). Persist the mode in `localStorage` key `ignex-debugbar-nav`.

- [ ] **Step 2: Implement `context-bar.tsx`**

`<div class="sticky top-0 z-30 flex h-(--context-h) items-center gap-3 border-b border-line bg-surface-1/90 px-4 backdrop-blur">` containing: hamburger (`Button variant="icon" icon="menu"`, calls `onToggleNav`), breadcrumb `service / View`, `ml-auto`, live-tail toggle (`Button` with `aria-pressed={paused()}` and `icon={paused() ? "play" : "pause"}`), refresh (`icon="refresh"`, `onClick={pushPulse}`), theme (`icon={theme()==="dark"?"sun":"moon"}`), palette trigger (`Button icon="search"` label `⌘K`).

- [ ] **Step 3: Implement `shell.tsx`**

Grid: `<div class="grid min-h-dvh" style={{ "grid-template-columns": navCollapsed ? "var(--sidebar-w-rail) 1fr" : "var(--sidebar-w) 1fr" }}>` on ≥760px; below 760px the sidebar is `position: fixed` off-canvas with a scrim. `<main class="min-w-0 px-4 py-4 pb-16 text-md">` with `<div class="mx-auto flex max-w-[1500px] flex-col gap-4">`. Status `<footer class="fixed inset-x-0 bottom-0 … pb-[env(safe-area-inset-bottom)]">`. Include a "Skip to content" link as the first focusable element. `AppShell` also runs the global keydown handler (adds `Cmd/Ctrl-K` → palette; keeps `0–9 / r / t`) and the delegated `[data-copy]` listener and `onCleanup` teardown that currently live in `app.tsx`.

- [ ] **Step 4: Rewrite `app.tsx`**

`App` = `<AppShell><ViewOutlet/></AppShell>`; keep `ViewOutlet`'s keyed route logic, the meta fetch (title/native/buffer text move into `AppShell`), the SSE `openStream` + polling watchdog, and move the status-bar content into `AppShell`.

- [ ] **Step 5: Verify + regenerate + commit**

Run: `bun run typecheck && bun run gen:debug-ui && bun run test:core`
Expected: PASS (smoke still finds `IgnEx Debugbar` and mounts every view).
Note: remove `views/registry.tsx` nav consumption from `app.tsx`; the sidebar consumes `NAV_GROUPS`.

```bash
git add packages/core/src/debug/ui/layout packages/core/src/debug/ui/app.tsx packages/core/src/debug/dashboard-client.gen.ts
git commit -m "feat(debug-ui): grouped sidebar shell with context bar"
```

## Task 9: Command palette component + toast a11y

**Files:**
- Create: `layout/command-palette.tsx`
- Modify: `toast.tsx`

- [ ] **Step 1: Implement the palette**

`<Show when={open()}>` → scrim (`bg-black/40`) + `<div role="dialog" aria-modal="true" aria-label="Command palette" class="… rounded-lg border border-line bg-surface-1 shadow-overlay">`. Search input autofocused; `For` over `filterCommands(buildCommands(deps), query())` grouped by `group`; arrow keys move an active index; Enter runs and closes; Escape closes; focus trap cycles within the dialog; restoring focus on close. Trigger lives in `ContextBar`; also opens on `Cmd/Ctrl-K`.

- [ ] **Step 2: Restyle `toast.tsx`**

`<div id="toast" role="status" aria-live="polite" class="fixed bottom-5 right-5 z-50 max-w-[420px] rounded-lg border border-line-strong bg-surface-2 px-4 py-2.5 text-sm text-ink shadow-overlay">`. Delete the dead `.show` class reference.

- [ ] **Step 3: Verify + regenerate + commit**

```bash
bun run typecheck && bun run lint && bun run gen:debug-ui && bun run test:core
git add packages/core/src/debug/ui/layout/command-palette.tsx packages/core/src/debug/ui/toast.tsx packages/core/src/debug/dashboard-client.gen.ts
git commit -m "feat(debug-ui): command palette and accessible toast"
```

---

# Phase 2 — List views

> **Pattern for every Phase 2 task.** Each view becomes: `PageHeader` (title, description, actions) → optional `StatRow` → `Toolbar` (filters) → `DataTable` → `EmptyState`/`LoadingState`/`ErrorState`. Replace emoji glyphs with `<Icon>`, replace local pills with `MethodBadge`/`StatusBadge`/`LevelBadge`/`KindBadge`, replace `class="search"` with `SearchInput`, replace `class="ghost mini"` with `Button`, and add `aria-label`/`title` where a cell truncates. Keep all data logic (stores, effects, effect baselines) byte-for-byte.

## Task 10: Requests + Errors

**Files:** Modify `views/requests.tsx`
**Interfaces:** Consumes `PageHeader Toolbar DataTable MethodBadge StatusBadge Button Stat StatRow`; produces no new exports.

- [ ] **Step 1: Migrate**

- `<PageHeader title={errorsOnly ? "Errors" : "Requests"} description="Live trace ring — newest first, last 200" actions={<><Button icon="pause" …/><Button icon="refresh" …/><Button variant="danger" icon="trash" …/></>} />`
- Keep `StatRow` with the same five `Stat`s; `duration` column index added to `DataTable` `align`; error cell keeps the `StatusBadge`.
- `DataTable` columns: `["When","Method","Path","Status","Duration","DB","Spans","Error"]`; `onRowClick={(r) => navigate("detail", r.id)}`; `empty={<EmptyState …/>}`; `loading` while first fetch is in flight.
- Remove the second `Panel` wrapper so the table is one `Card`; toolbar gains no actions (they moved to the header).

- [ ] **Step 2: Verify + regenerate + commit**

```bash
bun run gen:debug-ui && bun run test:core && bun run verify:quick
git add packages/core/src/debug/ui/views/requests.tsx packages/core/src/debug/dashboard-client.gen.ts
git commit -m "refactor(debug-ui): migrate Requests and Errors to primitives"
```

## Tasks 11–16: Logs, History, Routes, Jobs, Events, Clients

Each follows Task 10's pattern with the view-specific notes from spec §6.6:

- [ ] **Task 11 — Logs** (`views/logs.tsx`): filters in `Toolbar`; *persisted* becomes a header segmented control (two `Button`s, `aria-pressed`); message cell gets `max-w-[640px] truncate` + `title`; keep the trace link as `<a>`.
- [ ] **Task 12 — History** (`views/history.tsx`): `StatRow` renders only when persistence is live; toolbar keeps since/until/q/method/status/error/minMs; `minMs` input gets `w-28`.
- [ ] **Task 13 — Routes** (`views/routes.tsx`): header + search; route chips → `Badge`.
- [ ] **Task 14 — Jobs** (`views/jobs.tsx`): delete the local `StatusPill`; use `StatusBadge` for status families or `Badge` for job states.
- [ ] **Task 15 — Events** (`views/events.tsx`): the two composers become `Card`s with `Field`/`Select`/`SearchInput` (delete `.publish-composer`); toolbar gains source + direction filters; row cells use `Badge`/`DirPill`→`Badge`.
- [ ] **Task 16 — Clients** (`views/clients.tsx`): replace `ClientCard`/`.client-card`/`.client-head`/`.client-meta`/`.client-tags`/`.client-files` with `Card` + `CardGrid` + `Badge` + `Chip`; files remain copyable via `dataCopy`.

Each task ends:

```bash
bun run gen:debug-ui && bun run test:core && bun run verify:quick
git add packages/core/src/debug/ui/views/<view>.tsx packages/core/src/debug/dashboard-client.gen.ts
git commit -m "refactor(debug-ui): migrate <View> to primitives"
```

---

# Phase 3 — Dashboard views

## Task 17: Metrics

- [ ] Collapse the two `StatRow`s into one `StatGrid`; migrate the per-route and counters tables to `DataTable` with `align` on numeric columns; Prometheus card = `Card` with `Button dataCopy={promUrl}` + hint paragraph. Commit per the Phase 2 footer.

## Task 18: System + Chart primitive

**Files:** Create `components/chart.tsx`; modify `views/system.tsx`.

- [ ] **Step 1:** Implement `Chart(props: { title: string; unit: string; color: string; samples: () => Array<Record<string, number>>; field: string }): JSX.Element` — `<Card>` with header (`title`, current value, min/max) and a `<canvas>` inside a fixed-height box (`h-[120px]`); `createEffect` redraws; the canvas gets `role="img"` and an `aria-label` of the form `"<title>: <current> <unit>, min <min>, max <max>"`; the same numbers are rendered as text in the header so they exist without the canvas.
- [ ] **Step 2:** Replace `CHARTS`/`drawChart`/`ChartPanel` in `views/system.tsx` with `Chart` ×4 in a `CardGrid min={320}`; delete the bare `canvas {}` selector usage.
- [ ] **Step 3:** Verify + regenerate + commit.

## Task 19: Diagnostics

- [ ] Verdict banner → `Callout` (`tone` from verdict); findings → `Card` with a severity `Badge`, evidence `Kvs`, recommendation `Callout`; `EmptyState` when no findings; "run full GC" becomes the header primary action. Commit per the Phase 2 footer.

## Task 20: State

- [ ] Runtime → `Card`+`Kvs`; Features/Plugins → `Card`+`Chip`s; the raw `<details class="panel px-4 py-3.5">` becomes `Disclosure summary="Environment variable names" count={n}`. Commit per the Phase 2 footer.

---

# Phase 4 — Detail views

## Task 21: detail-parts + request detail

**Files:** Modify `components/detail-parts.tsx`, `views/request-detail.tsx`.

- [ ] **Step 1:** In `detail-parts.tsx`: keep the waterfall geometry CSS but move it into `styles.css` as irreducible custom styles (`.wf-*`, `.stack`, `.bd-row`) with the token fixes — remove `outline: 1px solid #fff` (use `outline: 2px solid var(--accent)`), replace the fixed `.wf-detail { margin-left: 240px }` with `margin-left: 0` on narrow and a grid that tracks the label column, and tokenise gap hatching. `TimeBreakdown`, `QueriesTable` and `BodyPanel` move onto `Card`/`DataTable`/`pre` classes.
- [ ] **Step 2:** In `request-detail.tsx`: `PageHeader` (back, `METHOD /path` title, `StatusBadge`, description = id/ip/time/source, actions = copy curl + replay); `DetailSummary` built from `Badge`/`Chip`; `Tabs` with ARIA and the existing `tab` route param; span tree restyle (keep `.tree` geometry as irreducible CSS, tokenised); loading → `LoadingState`; not-found → `ErrorState` whose message contains `404` (test-asserted).
- [ ] **Step 3:** Verify + regenerate + commit.

## Task 22: Log detail

- [ ] `PageHeader` (back, title, `LevelBadge`) + Record/Message/Fields `Card`s + request correlation link; preserve the `Live-ring records rotate out` not-found copy. Commit per the Phase 2 footer.

---

# Phase 5 — Reference

## Task 23: KT

**Files:** Modify `views/kt.tsx`; move irreducible `kt-*` CSS into `styles.css` or delete it.

- [ ] Remove `.kt-hero` gradient title/glow → `PageHeader` (title = service name) + env `Badge`s + right-aligned runtime meta block; every section becomes a `Card`; the project map uses `CardGrid`; pipeline stages use `Badge` + `Icon("arrow-right")`; docs list links to `#/docs/<path>`; the markdown fallback keeps scoped typography. Commit per the Phase 2 footer.

## Task 24: Docs

- [ ] Replace `grid grid-cols-[280px_1fr]` with a responsive two-pane (`lg:grid lg:grid-cols-[280px_1fr] gap-4`, stacked below `lg`); doc list gets a `SearchInput` filter + active state; content uses `Card` + `Markdown`; `EmptyState`s via the primitive. Deep links unchanged. Commit per the Phase 2 footer.

---

# Phase 6 — Cleanup, docs, tests

## Task 25: Delete dead CSS/classes and finish the stylesheet

- [ ] Remove from `styles.css` anything not currently referenced by a mounted view (grep each remaining selector across `ui/`); delete `.ok-text .brand-sub pre.codeblock .topbar .statusbar .sub .toast.show` and every one-off folded into a primitive. `styles.css` should contain only: imports, `@source`, `@custom-variant`, `@theme`, tokens, base resets, scrollbar/selection/focus, keyframes, and the irreducible `.wf*`/`.tree`/`.markdown` styles.
- [ ] Verify + regenerate + commit: `bun run gen:debug-ui && bun run verify:quick && bun run test:core`.

## Task 26: Extend the runtime smoke test

**Files:** Modify `packages/core/test/debugbar-dashboard-runtime.test.ts`.

- [ ] **Step 1:** After the existing view-shortcut loop, navigate to each of the 15 views and assert `document.querySelector("main h1")` text is non-empty; assert `document.body.textContent` contains no character from the old emoji set (`/[⚡◐⏸▶↻✕⚠✔✖🗄📄📚📈🗺📦⚙🧘🔌🔍🔗🗒]/u`).
- [ ] **Step 2:** Add a source-scan test to `packages/core/test/debug-ui-tokens.test.ts`: walk `src/debug/ui` recursively (`readdirSync(dir, { recursive: true })` from `node:fs`) and assert no `.ts`/`.tsx` matches `/text-\[/` (arbitrary typography) or `/\[#[0-9a-fA-F]{3,8}\]/` (arbitrary color). Arbitrary layout dimensions (grid templates, max-widths, fixed chart heights) stay allowed.
- [ ] **Step 3:** Run `bunx vitest run packages/core/test/debugbar-dashboard-runtime.test.ts packages/core/test/debug-ui-tokens.test.ts` — PASS.
- [ ] **Step 4:** Commit.

## Task 27: Style guide + docs

**Files:** Create `docs/debugbar-ui.md`; modify `docs/README.md`, `docs/debugbar.md`; delete `docs/superpowers/specs/2026-09-21-debugbar-ui-redesign-design.md`.

- [ ] **Step 1:** Write `docs/debugbar-ui.md`: purpose; the token tables (color/type/spacing/radius/motion) with the contrast floor; the **normative rule** ("utilities for layout, components for appearance, tokens for color, no `[Npx]`"); the component catalog with a one-line contract each; icon usage; accessibility bar; a "how to add a view" recipe (registry entry + `PageHeader` + primitives); the guard test and how to run it.
- [ ] **Step 2:** Add a row for `debugbar-ui.md` to `docs/README.md`; update the `docs/debugbar.md` UI tour (sidebar groups, palette, headers) and the `ui/` wiring bullets.
- [ ] **Step 3:** Fold the spec's live design content into `debugbar-ui.md` and `git rm docs/superpowers/specs/2026-09-21-debugbar-ui-redesign-design.md` (per its Disposition).
- [ ] **Step 4:** `bun run verify:quick && bun run test:core && bun run gen:debug-ui` — all green; commit.

---

## Self-Review

- **Spec coverage:** §6.1→T1–2; §6.2→T8; §6.3→T7/T9; §6.4→T3–4/T25; §6.5–6.6→T10–24; §6.7→T4 (aria in primitives), T8 (landmarks/skip link), T9 (toast/dialog), T18 (chart a11y), T26 (smoke); §7 rollout = phase order; §9 verification = per-task gates + T26; §8 docs = T27. §5 findings: #1/#2→T3–4/T25, #3→T1, #4→T4/T10, #5→T5/T8, #6→T24, #7→T4, #8→T21, #9→T21, #10→T4, #11→T1, #12→T21, #13→T1/T3, #14→T1, #15→T2, #16→T25, #17→T27.
- **Placeholder scan:** the only non-final content is icon path data (Task 2), which is art, not correctness — the `IconName` union and rendering contract are fixed. Everything else names exact files, interfaces and commands.
- **Type consistency:** `IconName`/`Icon` (T2) are used by T3/T5/T9/T20/T23; `Panel` alias (T4) keeps unmigrated views compiling until their task; `NAV_GROUPS` (T5) consumed by T8/T9; `buildCommands`/`filterCommands` (T7) consumed by T9; `resolveInitialTheme`/`initTheme` (T6) consumed by T8.
