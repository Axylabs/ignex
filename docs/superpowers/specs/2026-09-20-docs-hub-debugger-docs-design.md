# Design — Centralized docs hub + self-documenting debugger (enterprise docs)

Date: 2026-09-20 · Status: **proposed** · Owner: docs working group

## 0. Summary

Make ignex's documentation enterprise-grade in four connected moves:

1. **Centralized hub** — one `docs/README.md` that is *the* single entry point:
   a doc map with purpose, audience and maturity for every document, plus
   reading paths per persona.
2. **Self-documenting debugger** — a new **Docs** panel in the debugbar that
   renders the repo's actual markdown docs in the dashboard, so a developer
   opens one URL (`/__debugbar/#/docs`) and reads the framework docs without
   leaving the tool.
3. **Prune confusion** — delete completed process artifacts
   (`docs/superpowers/{plans,specs}`) that the repo's own rules say must not be
   kept, and trim a duplicated section; the hub's audience/maturity columns
   remove residual ambiguity instead of deleting working docs.
4. **Governance** — a mechanical **doc-hub check** (extended `check:maintainability`
   rule 6) that fails when any doc is missing from `docs/README.md`, so the map
   cannot rot. This is the "enterprise" guarantee: one source of truth, enforced.

Principle: **stable paths, additive surfaces.** No doc is renamed or moved;
the hub and the debugger panel are new. Breaks to the ~40 existing references
(skills, scripts, doc-rot guard, MCP, README/AGENTS) are therefore limited to
deletions we are *required* to make, not renames that force touch-ups.

## 1. Context and honest baseline

Today's docs are complete but unbundled. Nineteen top-level files in
`docs/`, three artifact dirs (`ai/`, `decisions/`, `superpowers/`), plus
`README.md` / `AGENTS.md` / `RULES.md` / `CONTRIBUTING.md` / `CHANGELOG.md` and
six skill files. AGENTS.md carries a doc-index table, README.md carries a
parallel docs list, and `docs/ai/first-day.md` + two skills each re-derive a
"where things live" map. Nothing states *which* doc a given reader (framework
user vs monorepo contributor vs AI agent) should start from, and nothing
enforces that the map stays complete.

Existing machinery we reuse, not rebuild:

- `scanDocsInventory(root, docsPaths)` in `packages/core/src/debug/kt.ts` —
  already lists every doc under the configured roots (titles from first
  heading, README first, deduped).
- `renderMarkdownHtml` + `sanitizeMdHtml` in `packages/core/src/debug/markdown.ts`
  — already render + sanitize KT markdown server-side (Bun.markdown, falls
  back to `null`).
- The debug UI view registry (`views/registry.tsx`, one entry per panel), the
  hash router (`ui/router.ts`), and the endpoint table
  (`debug/server/endpoints.ts`) — adding a panel is one entry + one module +
  one endpoint row, an established pattern.
- `scripts/check-maintainability.ts` rule 6 (doc-rot guard) with an existing
  self-test harness — the natural home for the new doc-hub check.

## 2. Part 1 — Centralized hub (`docs/README.md`)

New file `docs/README.md` with this structure:

1. **How to use the docs** — 3 lines stating who reads what
   (`Users` / `Contributors` / `AI agents`) and that this file is the only
   entry point.
2. **Doc map table** — every document, one row each:

   | Path | Topic (one line) | Audience | Maturity |
   | --- | --- | --- | --- |
   | `docs/architecture.md` | Architecture / monorepo layout | Contributors, AI agents | stable |
   | `docs/router.md` | Router: interpreted + AOT file routing | Users, Contributors | stable |
   | … (all 19 top-level + `docs/ai/LOCAL_DEV.md`, `docs/ai/first-day.md`, `docs/ai/maintaining.md`, `docs/ai/TREE.md`) | | | |

   Maturity values: `stable` / `evolving` / `reference`. The AGENTS.md
   "one owner per topic" table is **moved here** (it becomes the canonical
   map; AGENTS.md keeps a compact pointer, see §5).
3. **Reading paths per persona** — ordered lists:
   - Framework **user** (builds an app): `getting-started` → `router` →
     `cookbook` → `deployment` → `debugbar` → `drivers`.
   - **Contributor** (works in this repo): `first-day` → `adding-a-feature` →
     `architecture` → package skills → `release-process`.
   - AI **agent**: `AGENTS.md` + `first-day` + the debugger's own Docs/KT
     panels.
4. **Rules for artifact dirs** — `docs/ai/` (agent scaffolding), `docs/decisions/`
   (ADRs, D-001…), `docs/superpowers/` (process artifacts: written per task,
   **deleted when the work lands**, `git log` is the archive), `docs/ai/TREE.md`
   (generated — `bun run gen:ai-map`).
5. **Adding a doc** — the governance rule: every new doc gets a row in the
   doc map here, or it fails `check:maintainability` (§4). One owner per topic;
   never start a parallel doc when a row exists.

### 2.1 Edits that follow

- `README.md` — replace the inline docs bullet list (lines ~785–798) with a
  "Read the docs: `docs/README.md`" pointer plus the 3 most-read links.
- `AGENTS.md` — doc-index section becomes a compact pointer to
  `docs/README.md` (keep the command table; the full map lives in the hub).

## 3. Part 2 — Debugger Docs panel

### 3.1 Server

New module `packages/core/src/debug/docs.ts`:

```ts
// read the inventory (thin wrapper over scanDocsInventory, same roots/config)
export const listDocs = async (deps): Promise<KnowledgeDoc[]>
// read ONE doc, validated
export const readDoc = async (deps, requestedPath): Promise<DocPayload | null>
// DocPayload = { path, title, markdown, html }
```

Security contract: `requestedPath` must **exactly match an entry in the
scanned inventory** (normalized relative path, compared against `listDocs`
output). The inventory itself is produced by `scanDocsInventory`, which only
descends the configured roots (`docsPaths` + `projectRoot`) and does not
follow symlinks — so reads are permanently confined to listed docs, and any
absolute path, `..` traversal, or unlisted file returns `404`. The markdown
body is a server file; rendered output goes through the existing
`sanitizeMdHtml` allowlist. The endpoint inherits the debugbar's `auth: "gate"`
(and the production-elimination graph — debug-mode only by construction).

New handler `createDocsHandler(deps)` in `debug/server/handlers/app-panels.ts`:

- `GET /api/docs` → `{ docs: KnowledgeDoc[] }` (inventory, README first).
- `GET /api/docs?path=<relpath>` → `DocPayload` with `markdown` + sanitized
  `html` (+ `html: null` when `Bun.markdown` is unavailable → client falls
  back to a plain-markdown render).

Registered in `debug/server/endpoints.ts`:

```ts
{ methods: ["GET"], pattern: "docs", auth: "gate", handle: ... }
```

### 3.2 UI

- New `views/docs.tsx`: left sidebar = doc list (from `/api/docs`), content
  pane = rendered doc (use the sanitized `html` when present, else a minimal
  markdown→HTML fallback; styles reused from existing panel primitives).
- `views/registry.tsx` — one entry:
  `{ id: "docs", label: "Docs", key: "", domain: null, component: DocsView }`
  (placed next to KT, no digit shortcut — the 0–9 slots are full).
- `ui/router.ts` — add `"docs"` to `KNOWN_VIEWS`. Deep links:
  `#/docs` = inventory; `#/docs/<encodeURIComponent(relpath)>` = one doc
  (single URL-encoded segment so the path's `/` cannot split the route).
- `views/kt.tsx` — the Documentation panel gains an "open in Docs ↗" affordance
  (navigates to `#/docs/<encoded path>`), so KT and Docs cross-link.

### 3.3 Docs tables

- `docs/debugbar.md` — new panel in the UI tour + endpoints table row for
  `GET /api/docs` + deep links.
- `CHANGELOG.md` — `[Unreleased]` entry.
- Debugbar doc (`docs/debugbar.md` §KT/docs inventory) already documents the
  scan; add a sentence that the Docs panel renders those same docs.

## 4. Part 3 — Prune confusion

Delete (repo rule: completed plans are not kept as docs; conclusions already
folded into `docs/stability.md` / `CHANGELOG.md` / ADRs):

- `docs/superpowers/plans/2026-09-18-perf-levers.execution.md`
- `docs/superpowers/plans/2026-09-19-castrum-adoption.md`
- `docs/superpowers/plans/2026-09-20-maintainability-phase1.md`
- `docs/superpowers/plans/2026-09-20-maintainability-phase2.md`
- `docs/superpowers/plans/2026-09-20-offthread-task-consumer.md`
- `docs/superpowers/specs/2026-09-20-maintainability-design.md`

Trim `docs/ai/maintaining.md`: remove the "three-layer mental model" section
(lines ~32–38) — already canonical in `docs/ai/first-day.md`; keep the
symptom → origin → test table (that is the document's job).

Keep everything else. `getting-started` (users) and `first-day`
(monorepo agents) serve different readers — the hub's Audience column makes
the distinction explicit rather than deleted. `docs/ai/TREE.md` stays
generated. No docs are renamed or moved; all existing references keep working.

## 5. Part 4 — Governance (doc-hub check)

Extend `scripts/check-maintainability.ts` rule 6 (doc-rot guard):

- **New scope: doc-hub.** Every top-level `docs/*.md` and every
  `docs/ai/*.md` (excluding the generated `docs/ai/TREE.md`) must appear in
  the `docs/README.md` doc map (matched on the backticked path in the table).
  Violations fail the check with the missing paths listed.
- Extend the script's self-test fixtures: a `docs/ai/scratch-hub.md` written
  without a hub row must be reported; removing it must pass.

Supporting doc-discipline updates:

- `RULES.md` rule 5 — the sync list gains `docs/README.md` (the canonical map)
  and the doc-hub check.
- `AGENTS.md` — doc-index table replaced by the compact pointer (§2.1); the
  "one owner per topic — extend this table" governance line moves to the hub's
  "Adding a doc" section.

## 6. Verification

- `bun run verify:quick` (typecheck ×2, oxlint, biome, jsdoc:check:strict).
- `bun run check:maintainability` — new doc-hub fixtures turn green.
- `bun run gen:debug-ui --check` + regen via `bun run gen:debug-ui` (UI edits).
- Vitest: kt/endpoints/docs suites (`packages/core/test`), UI registry/router
  if covered.
- `bun run smoke` + `smoke:fallback`, then boot the reference app with
  `DEBUG=true bun run dev` and verify `/#/docs` lists and renders `docs/README.md`,
  `docs/router.md`, a `docs/ai/*` doc, and that `?path=` traversal is blocked.
- `bun run gen:ai-map` if the map tool needs regenerating (TREE.md untouched by
  this work — verify).

## 7. Out of scope

- Renaming/moving any existing doc (approach B) — explicitly rejected.
- A versioned docs website (Vitepress/Docusaurus) — hub + debugger panel
  first; a hosted site can consume `docs/README.md` later.
- Per-file frontmatter on all docs — the hub table is the single source of
  truth (frontmatter would duplicate it).
- Editing the content of the conceptual docs (architecture, router, …) beyond
  the two trims above.