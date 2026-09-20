# Docs Hub + Self-Documenting Debugger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize ignex documentation behind one `docs/README.md` hub, add a Docs panel to the debugbar that renders the repo's actual markdown docs, prune completed process artifacts, and enforce the doc map mechanically.

**Architecture:** Four connected changes: (1) a canonical `docs/README.md` hub with a path · topic · audience · maturity map plus reading paths per persona (README/AGENTS/RULES pointers shrink to it); (2) a new debugbar `Docs` panel — `GET /api/docs` endpoint (inventory + single-doc render, reads confined to the KT docs scan, existing markdown sanitizer) and a new SPA view `#/docs/<path>`; (3) deletion of the completed `docs/superpowers/{plans,specs}` artifacts and a trim of the duplicated mental-model section in `docs/ai/maintaining.md`; (4) a doc-hub rule in `scripts/check-maintainability.ts` that fails when any `docs/*.md` / `docs/ai/*.md` is missing from the hub map.

**Tech Stack:** Bun 1.4+, TypeScript, SolidJS SPA (compiled ahead of time by `scripts/gen-debug-ui.ts`), vitest, oxlint + Biome, `bun:sqlite`, the existing `Bun.markdown` + sanitizer.

**Spec:** `docs/superpowers/specs/2026-09-20-docs-hub-debugger-docs-design.md` (commit `f5136d2`). The plan argues from the spec; executors read both.

## Global Constraints

- Stable paths: no doc is renamed or moved; only deletions required by the repo rule and two pointer edits.
- Repo rule: completed plans and dated measurement logs are not kept as docs — completed `docs/superpowers/{plans,specs}` files are deleted (their live conclusions already live in `docs/stability.md` / ADRs / `CHANGELOG.md`); `git log` is the archive.
- The doc-hub check covers top-level `docs/*.md` and `docs/ai/*.md` only — NOT `docs/README.md` itself, NOT the generated `docs/ai/TREE.md`, NOT `docs/decisions/`, NOT `docs/superpowers/`.
- Debugbar endpoints are debug-mode only by construction (the production-elimination graph drops them from prod-shaped builds) — the new `docs` endpoint inherits that automatically via the endpoint table.
- The Docs panel reads ONLY files present in the uncapped KT docs inventory (`listAllDocs`): absolute paths, `..` traversal, and unlisted files return 404 — never read.
- Every rendered doc HTML passes through the existing `sanitizeMdHtml` allowlist.
- Do not touch `docs/ai/TREE.md` by hand — regenerate with `bun run gen:ai-map` if it drifts.
- Keep `CHANGELOG.md` under the single `[Unreleased]` heading at workspace version 0.1.32; never hand-write release headings.
- Functional composition, no classes on public surfaces; match surrounding style (factories, small pure functions, `@fileoverview` doc blocks, JSDoc on exports, vitest).

---

### Task 1: Prune completed process artifacts + trim `maintaining.md`

**Files:**
- Delete: `docs/superpowers/plans/2026-09-18-perf-levers.execution.md`
- Delete: `docs/superpowers/plans/2026-09-19-castrum-adoption.md`
- Delete: `docs/superpowers/plans/2026-09-20-maintainability-phase1.md`
- Delete: `docs/superpowers/plans/2026-09-20-maintainability-phase2.md`
- Delete: `docs/superpowers/plans/2026-09-20-offthread-task-consumer.md`
- Delete: `docs/superpowers/specs/2026-09-20-maintainability-design.md`
- Modify: `docs/ai/maintaining.md:32-38` (remove the duplicated "## The three-layer mental model" section — already canonical in `docs/ai/first-day.md`)

**Interfaces:**
- Consumes: nothing.
- Produces: a clean `docs/` where top-level docs are the only durable user docs; `docs/ai/maintaining.md` keeps only the symptom → origin → test table.

- [ ] **Step 1: Confirm the plan/spec are the completed artifacts**

Run: `git log --oneline -8 -- docs/superpowers`
Expected: recent commits read "docs(plans): mark maintainability Phase 2 complete" etc. — the work these files describe is landed (their conclusions are folded into `docs/stability.md` and `CHANGELOG.md`).

- [ ] **Step 2: Grep for dangling references before deleting**

Run:
```bash
grep -rn "maintainability-design\|maintainability-phase\|perf-levers.execution\|castrum-adoption\|offthread-task-consumer" --include="*.md" --include="*.ts" --include="*.json" . | grep -v node_modules
```
Expected: only `docs/ai/TREE.md` may mention process dir paths (it is regenerated later, Task 9); any other hit must be resolved before deletion. Do not delete if a live reference exists — resolve it first.

- [ ] **Step 3: Delete the six completed artifacts**

```bash
git rm docs/superpowers/plans/2026-09-18-perf-levers.execution.md \
       docs/superpowers/plans/2026-09-19-castrum-adoption.md \
       docs/superpowers/plans/2026-09-20-maintainability-phase1.md \
       docs/superpowers/plans/2026-09-20-maintainability-phase2.md \
       docs/superpowers/plans/2026-09-20-offthread-task-consumer.md \
       docs/superpowers/specs/2026-09-20-maintainability-design.md
```
(The new spec `2026-09-20-docs-hub-debugger-docs-design.md` and this plan stay — they are live process artifacts for the current work.)

- [ ] **Step 4: Trim the duplicated section in `docs/ai/maintaining.md`**

Remove lines 32–38 (the `## The three-layer mental model` block, from that heading through the "Where from" bullet and the blank line). Keep the seed table and the closing paragraph (lines 40–42) intact.

- [ ] **Step 5: Verify pruning did not break references**

Run: `bun run check:maintainability`
Expected: PASS — decisions/skills/docs-ai citations still resolve; no new diags.

- [ ] **Step 6: Commit**

```bash
git add -A docs/superpowers docs/ai/maintaining.md
git commit -m "docs(prune): remove completed plan/spec artifacts; drop duplicated mental-model section from maintaining.md"
```

---

### Task 2: `docs/README.md` hub + pointer redirects

**Files:**
- Create: `docs/README.md` — the documentation hub (doc map + persona reading paths + artifact rules + adding-a-doc governance)
- Modify: `README.md:785-800` (replace the 11-item Learn More list with a hub pointer + 3 most-read links)
- Modify: `AGENTS.md` doc-index section (lines ~86–103) — replace the full table with a compact pointer to `docs/README.md`
- Modify: `RULES.md:99-100` — "The authoritative list is the Doc index table in `AGENTS.md`" → `docs/README.md`

**Interfaces:**
- Consumes: Task 1's pruned doc set.
- Produces: `docs/README.md` whose doc map lists EVERY durable doc with a backticked path row — Task 8's doc-hub check parses it. Keep the table column shape `| `docs/architecture.md` | … | … | … |` (backticked token must start with `docs/` and end with `.md`).

- [ ] **Step 1: Write `docs/README.md`**

Create the hub with exactly these sections:

```markdown
# ignex documentation

One entry point for every document in this repository. If you are unsure where
to start, start here.

## How to use the docs

Three audiences, three reading paths (see below). Every doc has one row in the
map: **audience** (`Users` = build an app with ignex, `Contributors` = work in
this repo, `AI agents` = tooling/agents operating on the repo) and **maturity**
(`stable` = won't change casually, `evolving` = changes with the code,
`reference` = tables/contracts to look up). One owner per topic: if a row
exists, extend it — never start a parallel doc.

## Doc map

| Path | Topic | Audience | Maturity |
| --- | --- | --- | --- |
| `docs/architecture.md` | Architecture / monorepo layout | Contributors, AI agents | stable |
| `docs/router.md` | Router: interpreted `createRouter` + AOT file routing | Users, Contributors | stable |
| `docs/native-acceleration.md` | castrum bridge, SELECTION, pure-TS fallbacks | Contributors | stable |
| `docs/perf-methodology.md` | Measuring perf: methodology, cost budget, ruled-out hypotheses | Contributors | reference |
| `docs/comparison-bench.md` | Cross-framework comparison bench | Contributors | reference |
| `docs/bun-internals.md` | Bun runtime internals we rely on | Contributors | reference |
| `docs/compatibility.md` | Compatibility with nova / ninox / castrum | Users, Contributors | stable |
| `docs/sdk.md` | SDK generation and distribution | Users, Contributors | stable |
| `docs/debugbar.md` | Debugbar + observatory (dashboard, driver protocol, Docs panel) | Users, Contributors | evolving |
| `docs/drivers.md` | DB drivers (sqlite / mongo / drizzle) | Users | stable |
| `docs/deployment.md` | Deployment (Bun binary, Docker, proxies) | Users | stable |
| `docs/getting-started.md` | First-run tutorial | Users | stable |
| `docs/cookbook.md` | Task recipes | Users | evolving |
| `docs/adding-a-feature.md` | Adding a feature (workflow + gates) | Contributors | stable |
| `docs/release-process.md` | Release checklist + version files | Contributors | stable |
| `docs/stability.md` | Known risks, gate matrix, further work | Contributors, AI agents | evolving |
| `docs/ai/first-day.md` | Agent onboarding: run it, the three-layer model, exercises | AI agents | stable |
| `docs/ai/LOCAL_DEV.md` | Cross-repo `bun link` development | Contributors, AI agents | stable |
| `docs/ai/maintaining.md` | Symptom → origin module → pinning test | Contributors, AI agents | evolving |
| `docs/ai/TREE.md` | Auto-generated structural snapshot (`bun run gen:ai-map`) | AI agents | reference |

`docs/decisions/` (D-001…) — accepted design decisions with Verification
clauses; read the numbered entry when a design choice is in play. `RULES.md` /
`AGENTS.md` / `CONTRIBUTING.md` / `CHANGELOG.md` at the repo root are not part
of the map: rules, agent how-to, contribution workflow, and the versioned log.

## Reading paths

- **Framework user** (build an app): `docs/getting-started.md` → `docs/router.md`
  → `docs/cookbook.md` → `docs/deployment.md` → `docs/debugbar.md` →
  `docs/drivers.md`.
- **Contributor** (work in this repo): `docs/ai/first-day.md` →
  `docs/adding-a-feature.md` → `docs/architecture.md` → the `.agents/skills/`
  runbook for your area → `docs/release-process.md`.
- **AI agent**: `AGENTS.md` (commands + rules) → `docs/ai/first-day.md` →
  the debugger's own Docs and KT panels at `/__debugbar/#/docs` and
  `/__debugbar/#/kt` (rendered from the same scan).

## Artifact directories

- `docs/ai/` — agent scaffolding (first-day, LOCAL_DEV, maintaining, the
  generated TREE.md). Regenerate the tree with `bun run gen:ai-map`.
- `docs/decisions/` — ADRs (D-001…): one template, one numbered entry per
  accepted design choice, each with a Verification clause.
- `docs/superpowers/` — process artifacts (design specs + execution plans)
  written per task. **Deleted when the work lands**: fold the still-live
  conclusion into the owning doc or `CHANGELOG.md`; `git log` is the archive.

## Adding a doc

Every new doc gets a row in the Doc map above, or `bun run
check:maintainability` fails (`doc-hub:missing`). One owner per topic: prefer
extending the row's doc over creating a sibling. Never delete or rename a doc
without grepping for references (`docs/`, `AGENTS.md`, `RULES.md`,
`.agents/skills/`, source comments, `CHANGELOG.md`, workflows).
```

- [ ] **Step 2: Shrink the README `Learn More` section**

Replace the list at `README.md:785-800` with:

```markdown
## Learn More

The full documentation map (every doc, its audience and maturity) lives in
[docs/README.md](docs/README.md) — start there.

- [docs/getting-started.md](docs/getting-started.md) — the full walkthrough.
- [docs/cookbook.md](docs/cookbook.md) — copy-paste recipes.
- [docs/debugbar.md](docs/debugbar.md) — the developer dashboard (and its
  built-in Docs panel).
```

- [ ] **Step 3: Compact the AGENTS.md doc index**

Replace the doc-index table (the `| Topic | Doc |` block under `## Doc index`)
with:

```markdown
## Doc index

The canonical map — every doc, its audience and maturity, plus reading paths
per persona — is **`docs/README.md`** (one owner per topic: extend a row, never
start a parallel doc; `check:maintainability` enforces it). Quick links:
`docs/architecture.md`, `docs/router.md`, `docs/getting-started.md`,
`docs/adding-a-feature.md`, `docs/release-process.md`, `docs/debugbar.md`,
`docs/ai/first-day.md`, `docs/ai/LOCAL_DEV.md`, `docs/ai/TREE.md`.
```

- [ ] **Step 4: Point RULES.md at the hub**

In `RULES.md` rule 6 (docs discipline), change:

```markdown
- **One doc per topic.** The authoritative list is the "Doc index" table in
  `AGENTS.md` — add a row there, do not add a second doc on a covered topic.
```

to:

```markdown
- **One doc per topic.** The authoritative list is the doc map in
  `docs/README.md` — add a row there, do not add a second doc on a covered
  topic (`bun run check:maintainability` enforces it).
```

- [ ] **Step 5: Verify the map covers every durable doc**

Run:
```bash
for f in docs/*.md docs/ai/*.md; do
  base="${f#docs/}"; base="docs/${base#ai/}"  # normalize for the map key
  grep -q "\`${f#./}\`" docs/README.md || echo "MISSING: $f"
done
```
Expected: no `MISSING:` lines (TREE.md is listed too; decisions/superpowers are intentionally absent).

- [ ] **Step 6: Commit**

```bash
git add docs/README.md README.md AGENTS.md RULES.md
git commit -m "docs(hub): add docs/README.md canonical doc map; redirect README/AGENTS/RULES pointers to it"
```

---

### Task 3: `scanDocsInventory` limit + `listAllDocs` (uncapped inventory)

**Files:**
- Modify: `packages/core/src/debug/kt.ts:521-540` (`scanDocsInventory`)
- Test: `packages/core/test/debug-docs.test.ts` (new file; shared by Task 4)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `scanDocsInventory(root: string, paths?: readonly string[], limit = 40): Promise<KnowledgeDoc[]>`
  - `listAllDocs(root: string, paths?: readonly string[]): Promise<KnowledgeDoc[]>` — uncapped (10_000), used by Task 4's read gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/debug-docs.test.ts`:

```ts
/**
 * @fileoverview Docs panel tests — inventory capping / uncapped listing and
 * (Task 4) the single-doc read path with traversal guards.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listAllDocs, scanDocsInventory } from "../src/debug/kt";

let dir: string;
let many: string;

const makeDocs = (root: string, names: string[]): void => {
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const n of names) writeFileSync(join(root, "docs", n), `# ${n}\n`);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ignex-docs-"));
  makeDocs(dir, ["a.md", "b.md"]);
  many = mkdtempSync(join(tmpdir(), "ignex-docs-many-"));
  makeDocs(many, Array.from({ length: 45 }, (_, i) => `d${String(i).padStart(2, "0")}.md`));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(many, { recursive: true, force: true });
});

describe("docs inventory", () => {
  it("default scan caps at 40 entries", async () => {
    const docs = await scanDocsInventory(many, ["docs"]);
    expect(docs.length).toBe(40);
  });

  it("listAllDocs returns the full inventory (read-path gate)", async () => {
    const docs = await listAllDocs(many, ["docs"]);
    expect(docs.length).toBe(45);
    expect(docs[0]?.path).toBe("docs/d00.md"); // sorted, README first then alpha
  });

  it("extracts titles from the first heading", async () => {
    const docs = await listAllDocs(dir, ["docs"]);
    expect(docs).toEqual([
      { path: "docs/a.md", title: "a.md" },
      { path: "docs/b.md", title: "b.md" },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: FAIL — `scanDocsInventory` has no `limit` argument and `listAllDocs` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/debug/kt.ts`, change the `scanDocsInventory` signature and tail:

```ts
export const scanDocsInventory = async (
  root: string,
  paths?: readonly string[],
  limit = 40,
): Promise<KnowledgeDoc[]> => {
  const seen = new Set<string>();
  const docs: KnowledgeDoc[] = [];
  for (const scanPath of paths?.length ? paths : defaultDocsPaths) {
    for (const doc of await collectDocsUnderRoot(root, scanPath)) {
      if (seen.has(doc.path)) continue;
      seen.add(doc.path);
      docs.push(doc);
    }
  }
  return docs
    .sort((a, b) => {
      const readme = (p: string) => (basename(p).toLowerCase() === "readme.md" ? 0 : 1);
      return readme(a.path) - readme(b.path) || a.path.localeCompare(b.path);
    })
    .slice(0, limit);
};

/** Full inventory (no cap) — the Docs panel read gate reads only these. */
export const listAllDocs = (
  root: string,
  paths?: readonly string[],
): Promise<KnowledgeDoc[]> => scanDocsInventory(root, paths, 10_000);
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/debug/kt.ts packages/core/test/debug-docs.test.ts
git commit -m "feat(core): uncapped listAllDocs for the debug docs read path; scanDocsInventory gains a limit"
```

---

### Task 4: `docs.ts` — single-doc read with traversal guards

**Files:**
- Create: `packages/core/src/debug/docs.ts`
- Modify: `packages/core/src/debug/types/knowledge.ts` (add `DocPayload` next to `KnowledgeDoc`)
- Test: `packages/core/test/debug-docs.test.ts` (extend)

**Interfaces:**
- Consumes: `listAllDocs` (Task 3), `renderMarkdownHtml` from `./markdown`, `KnowledgeDoc` type.
- Produces:
  - `DocPayload` in `types/knowledge.ts`:
    ```ts
    /** One doc served by the Debugbar Docs panel (`GET /api/docs?path=`). */
    export interface DocPayload {
      readonly path: string;
      readonly title: string;
      readonly markdown: string;
      readonly html: string | null;
    }
    ```
  - `readDoc(root: string, docsPaths: readonly string[], requestedPath: string): Promise<DocPayload | null>` — `null` for any path not in the inventory (never reads outside).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/debug-docs.test.ts`:

```ts
import { readDoc } from "../src/debug/docs";

describe("readDoc — one doc, confined to the inventory", () => {
  it("reads a listed doc with title, markdown and sanitized-or-null html", async () => {
    const doc = await readDoc(dir, ["docs"], "docs/a.md");
    expect(doc).not.toBeNull();
    expect(doc?.path).toBe("docs/a.md");
    expect(doc?.title).toBe("a.md");
    expect(doc?.markdown).toBe("# a.md\n");
    // No Bun global in vitest → server render unavailable → client fallback.
    expect(doc?.html).toBeNull();
  });

  it("returns null for traversal and unlisted paths (never reads outside)", async () => {
    expect(await readDoc(dir, ["docs"], "docs/nope.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "../secret.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "docs/../a.md")).toBeNull();
    expect(await readDoc(dir, ["docs"], "/etc/passwd")).toBeNull();
    expect(await readDoc(dir, ["docs"], "C:\\Windows\\x.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: FAIL — `readDoc` not exported.

- [ ] **Step 3: Implement `docs.ts`**

```ts
/**
 * @fileoverview Docs panel data — list + single-doc reads confined to the KT
 * docs inventory (same roots as the KT page). Security: `readDoc` only ever
 * reads paths present in the inventory produced by `scanDocsInventory` (real
 * `.md` files under the allowed roots, no symlink following), so traversal —
 * absolute paths, `..`, unlisted files — can only yield `null`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { listAllDocs } from "./kt";
import { renderMarkdownHtml } from "./markdown";
import type { DocPayload, KnowledgeDoc } from "./types";

/** The Docs panel inventory (`GET /api/docs`). */
export const listDocs = (root: string, docsPaths: readonly string[]): Promise<KnowledgeDoc[]> =>
  listAllDocs(root, docsPaths);

/** Read one doc — `null` unless it is an inventory entry (never reads outside). */
export const readDoc = async (
  root: string,
  docsPaths: readonly string[],
  requestedPath: string,
): Promise<DocPayload | null> => {
  const docs = await listAllDocs(root, docsPaths);
  const entry = docs.find((d) => d.path === requestedPath);
  if (entry === undefined) return null;
  // `entry.path` is root-relative (or absolute for outside-root docs); resolve
  // against the scan root so the file is read at the scanned location, never
  // against the process cwd.
  const markdown = await readFile(resolve(root, entry.path), "utf8").catch(() => null);
  if (markdown === null) return null;
  return {
    path: entry.path,
    title: entry.title,
    markdown,
    html: renderMarkdownHtml(markdown),
  };
};
```

Note: `entry.path` is repo-relative when the doc sits under the project root
(e.g. `docs/a.md`) and absolute otherwise — `resolve(root, …)` accepts both,
and only paths that survived the scan can appear.

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/debug/docs.ts packages/core/src/debug/types/knowledge.ts packages/core/test/debug-docs.test.ts
git commit -m "feat(core): docs.ts readDoc — inventory-confined single-doc reads for the Docs panel"
```

---

### Task 5: `GET /api/docs` endpoint

**Files:**
- Modify: `packages/core/src/debug/server/handlers/app-panels.ts` (add `createDocsHandler` + imports)
- Modify: `packages/core/src/debug/server/endpoints.ts` (import + register the endpoint)
- Test: `packages/core/test/debug-docs.test.ts` (extend)

**Interfaces:**
- Consumes: `scanDocsInventory` (Task 3), `readDoc` + `DocPayload` (Task 4), `json` from `../respond`, `HandlerDeps` from `../server/types`.
- Produces: `createDocsHandler(deps: HandlerDeps) => (ctx: IgnexContext) => Promise<Response>` — `GET /api/docs` (list) and `GET /api/docs?path=<relpath>` (one doc, 404 for unknown/traversal paths).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/debug-docs.test.ts`:

```ts
import { createDocsHandler } from "../src/debug/server/handlers/app-panels";

describe("GET /api/docs endpoint", () => {
  // Build deps inside each test — `dir` is assigned in beforeAll, which runs
  // after the describe body executes.
  const deps = (): never => ({ state: { projectRoot: dir, docsPaths: ["docs"] } }) as never;

  it("lists the inventory", async () => {
    const handler = createDocsHandler(deps());
    const res = await handler({ url: new URL("http://x/api/docs") } as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      docs: [
        { path: "docs/a.md", title: "a.md" },
        { path: "docs/b.md", title: "b.md" },
      ],
    });
  });

  it("returns one doc for ?path=", async () => {
    const handler = createDocsHandler(deps());
    const res = await handler({
      url: new URL("http://x/api/docs?path=docs%2Fa.md"),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; markdown: string };
    expect(body.path).toBe("docs/a.md");
    expect(body.markdown).toBe("# a.md\n");
  });

  it("404s for an unknown or traversal path", async () => {
    const handler = createDocsHandler(deps());
    const res = await handler({
      url: new URL("http://x/api/docs?path=..%2Fsecret.md"),
    } as never);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: FAIL — `createDocsHandler` not exported.

- [ ] **Step 3: Implement the handler**

In `packages/core/src/debug/server/handlers/app-panels.ts`, add imports from `../../docs` and `../../kt`:

```ts
import { readDoc } from "../../docs";
import { scanDocsInventory } from "../../kt";
```

and export (place after `createKtData`):

```ts
/** `GET /api/docs` — docs inventory; `?path=` returns one rendered doc. */
export const createDocsHandler =
  (deps: HandlerDeps) =>
  async (ctx: IgnexContext): Promise<Response> => {
    const root = deps.state.projectRoot;
    const paths = deps.state.docsPaths;
    const rel = (ctx.url.searchParams.get("path") ?? "").trim();
    if (rel === "") {
      return json({ docs: await scanDocsInventory(root, paths) });
    }
    const doc = await readDoc(root, paths, rel);
    if (doc === null) return json({ error: "unknown doc" }, 404);
    return json(doc);
  };
```

- [ ] **Step 4: Register the endpoint**

In `packages/core/src/debug/server/endpoints.ts`, add `createDocsHandler` to the `app-panels` import block, and register next to the `kt` row:

```ts
{
  methods: ["GET"],
  pattern: "docs",
  auth: "gate",
  handle: (ctx) => createDocsHandler(deps)(ctx),
},
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run packages/core/test/debug-docs.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/debug/server/handlers/app-panels.ts packages/core/src/debug/server/endpoints.ts packages/core/test/debug-docs.test.ts
git commit -m "feat(core): GET /api/docs endpoint (inventory + single-doc render) for the Docs panel"
```

---

### Task 6: Docs panel UI (view, router, registry, KT link)

**Files:**
- Modify: `packages/core/src/debug/ui/api.ts` (add `getDocs`, `getDoc` + `DocPayload` type import)
- Modify: `packages/core/src/debug/ui/router.ts` (`KNOWN_VIEWS` + `docs` parse/navigate)
- Modify: `packages/core/src/debug/ui/views/registry.tsx` (add the `docs` view)
- Create: `packages/core/src/debug/ui/views/docs.tsx`
- Modify: `packages/core/src/debug/ui/views/kt.tsx` (Documentation rows gain "open in Docs ↗")
- Modify: `packages/core/test/debug-ui-router.test.ts` (docs route coverage)
- Modify: `packages/core/test/debugbar-dashboard-runtime.test.ts` (stub `/api/docs`)

**Interfaces:**
- Consumes: `getDocs`/`getDoc` (this task), `currentRoute`/`navigate` from `../router`, widgets from `../components/widgets`, `KnowledgeDoc` + `DocPayload` types.
- Produces:
  - `getDocs(): Promise<{ docs: KnowledgeDoc[] }>` and `getDoc(path: string): Promise<DocPayload>` in `api.ts`.
  - Route `#/docs` (inventory) and `#/docs/<encodeURIComponent(relpath)>` (one doc); `navigate("docs", path)`.
  - `DocsView` registered as `{ id: "docs", label: "Docs", key: "", domain: null }` (no digit shortcut — 0–9 slots are full).

- [ ] **Step 1: Write the failing router test**

Append to `packages/core/test/debug-ui-router.test.ts`:

```ts
it("parses docs list and doc-detail routes (encoded single segment)", () => {
  navigate("docs");
  expect(currentRoute()).toEqual({ view: "docs", id: null, tab: null });
  navigate("docs", "docs/router.md");
  expect(currentRoute()).toEqual({ view: "docs", id: "docs/router.md", tab: null });
  expect(window.location.hash).toBe("#/docs/docs%2Frouter.md");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run packages/core/test/debug-ui-router.test.ts`
Expected: FAIL — `docs` is not a known view (`navigate` on an unknown view resets to `#/docs` fallback → route is `requests`).

- [ ] **Step 3: Implement the API client + router**

In `packages/core/src/debug/ui/api.ts` — add `DocPayload` to the `../types` import list, then:

```ts
/** `GET /api/docs` — docs inventory for the Docs panel. */
export const getDocs = (): Promise<{ docs: KnowledgeDoc[] }> => getJson("/docs");

/** `GET /api/docs?path=` — one doc, rendered server-side when available. */
export const getDoc = (path: string): Promise<DocPayload> =>
  getJson(`/docs?path=${encodeURIComponent(path)}`);
```

(Add `KnowledgeDoc` to the `../types` import list too.)

In `packages/core/src/debug/ui/router.ts`:

- Add `"docs"` to `KNOWN_VIEWS`.
- In `parse`, after the `logs` block:

```ts
if (head === "docs" && parts[1] !== undefined) {
  return { view: "docs", id: decodeURIComponent(parts[1]), tab: null };
}
```

- In `navigate`, add a branch before the generic fallback:

```ts
else if (view === "docs") {
  hash = id !== undefined ? `#/docs/${encodeURIComponent(id)}` : "#/docs";
}
```

- [ ] **Step 4: Implement the view + registry entry**

Create `packages/core/src/debug/ui/views/docs.tsx`:

```tsx
/**
 * @fileoverview Docs view — the framework/repo documentation rendered inside
 * the debugbar. Sidebar = the docs inventory (same scan as KT); content =
 * the selected doc (sanitized server HTML, or a plain-markdown fallback when
 * the server renderer is unavailable). Deep links: `#/docs`, `#/docs/<path>`.
 */

import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";

import { getDoc, getDocs } from "../api";
import { EmptyState, Panel } from "../components/widgets";
import { currentRoute, navigate } from "../router";
import type { KnowledgeDoc } from "../../types";

/** The docs panel. */
export const DocsView: Component = () => {
  const [docs, setDocs] = createSignal<KnowledgeDoc[]>([]);
  const [enabled, setEnabled] = createSignal(true);
  const [html, setHtml] = createSignal<string | null>(null);
  const [markdown, setMarkdown] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  void getDocs()
    .then((res) => setDocs(res.docs ?? []))
    .catch(() => setEnabled(false));

  // Load the selected doc whenever the route's doc id changes.
  createEffect(() => {
    const path = currentRoute().id;
    if (path === null) {
      setTitle("");
      setHtml(null);
      setMarkdown("");
      setError(null);
      return;
    }
    void getDoc(path)
      .then((d) => {
        setTitle(d.title);
        setHtml(d.html);
        setMarkdown(d.markdown);
        setError(null);
      })
      .catch(() => setError("Could not load this document."));
  });

  return (
    <div class="grid grid-cols-[280px_1fr] items-start gap-[18px]">
      <Panel title="Documentation">
        <Show when={docs().length === 0} fallback={<></>}>
          <EmptyState
            glyph="📄"
            message="No docs found."
            hint="Set debugbar({ docsPaths }) to scan your repository's docs."
          />
        </Show>
        <div class="kt-rows">
          <For each={docs()}>
            {(doc): JSX.Element => (
              <button
                type="button"
                class={`kt-row w-full text-left ${doc.path === currentRoute().id ? "active" : ""}`}
                onClick={(): void => navigate("docs", doc.path)}
              >
                <div class="t">📄 {doc.title}</div>
                <div class="p font-mono">{doc.path}</div>
              </button>
            )}
          </For>
        </div>
      </Panel>
      <div>
        <Show when={currentRoute().id === null} fallback={<></>}>
          <Panel title="Docs">
            <EmptyState
              glyph="📚"
              message="Pick a document from the sidebar."
              hint="Docs are rendered from the same scan as the KT page (debugbar docsPaths)."
            />
          </Panel>
        </Show>
        <Show when={currentRoute().id !== null}>
          <Panel title={title() || "Document"}>
            <Show when={error() === null} fallback={<EmptyState glyph="⚠️" message={error() ?? ""} />}>
              <article class="markdown" innerHTML={html() ?? ""} />
              <Show when={html() === null}>
                <pre class="overflow-auto whitespace-pre-wrap p-[14px]">{markdown()}</pre>
              </Show>
            </Show>
          </Panel>
        </Show>
      </div>
      <Show when={!enabled()}>
        <EmptyState
          glyph="📄"
          message="Docs unavailable."
          hint="The docs endpoint did not respond."
        />
      </Show>
    </div>
  );
};
```

In `packages/core/src/debug/ui/views/registry.tsx`, add `DocsView` to the import block and a row after `kt`:

```tsx
{ id: "docs", label: "Docs", key: "", domain: null, component: DocsView },
```

In `packages/core/src/debug/ui/views/kt.tsx` — add `navigate` to the `../router` import and give each Documentation row an "open" action (inside the existing `k.docs.map` row, after the path div):

```tsx
<button
  type="button"
  class="ghost mini"
  onClick={(): void => navigate("docs", doc.path)}
  title="open in Docs"
>
  open ↗
</button>
```

- [ ] **Step 5: Update the dashboard runtime test stubs**

In `packages/core/test/debugbar-dashboard-runtime.test.ts`, inside `apiPayload`, add a branch before the final generic fallback:

```ts
if (url.includes("/api/docs")) {
  const path = new URL(url, "http://x").searchParams.get("path");
  return {
    ok: true,
    status: 200,
    json: () =>
      path === null
        ? Promise.resolve({ docs: [{ path: "docs/a.md", title: "Alpha" }] })
        : Promise.resolve({
            path,
            title: "Alpha",
            markdown: "# Alpha\n",
            html: "<h1>Alpha</h1>",
          }),
    text: () => Promise.resolve(""),
  };
}
```

(Confirm from the file's existing stub shape that `ok/status/json/text` is the convention; match it exactly.)

- [ ] **Step 6: Run the UI tests**

Run: `bunx vitest run packages/core/test/debug-ui-router.test.ts packages/core/test/debugbar-dashboard-runtime.test.ts`
Expected: PASS.

- [ ] **Step 7: Regenerate the committed SPA bundle**

Run: `bun run gen:debug-ui`
Expected: `packages/core/src/debug/dashboard-client.gen.ts` regenerates (content-hash ETag changes). Then `bun run check:debug-ui` passes.

- [ ] **Step 8: Typecheck the core package**

Run: `bun run typecheck`
Expected: no new diagnostics.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/debug/ui packages/core/test/debug-ui-router.test.ts packages/core/test/debugbar-dashboard-runtime.test.ts packages/core/src/debug/dashboard-client.gen.ts
git commit -m "feat(debug): Docs panel — #/docs view rendering the repo docs, with KT cross-link"
```

(The SPA source is `dashboard-client.gen.ts` only — the runtime test's
`.gen.js` import is resolved to that `.ts` file by Bun; there is no separate
`.js` artifact to commit.)

---

### Task 7: Reference app — scan the framework docs

**Files:**
- Modify: `packages/app/src/app.config.ts` (debugbar options — add `docsPaths`)

**Interfaces:**
- Consumes: the `Docs` view + endpoint (Tasks 4–6).
- Produces: the reference app's `/__debugbar/#/docs` lists/renders the monorepo framework docs.

- [ ] **Step 1: Add `docsPaths`**

In the `debugbar({ ... })` options under the `...(env.DEBUG ? [...] : [])` block, add after `serviceName`:

```ts
// Framework docs for the Docs + KT panels (paths resolve from packages/app —
// the compiler's `dev`/`build` scripts run with --cwd packages/app).
docsPaths: ["../../docs", "../../README.md"],
```

- [ ] **Step 2: Verify docs are discovered**

```bash
DEBUG=true bun run dev
```
(background); then:

```bash
curl -s http://localhost:3000/__debugbar/api/docs | head -c 400
```
Expected: a JSON `docs` array whose first entry is the repo `README.md`, including `docs/README.md`, `docs/router.md`, `docs/debugbar.md` — proof that `../../docs` resolved. Kill the dev server.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/app.config.ts
git commit -m "feat(app): point the reference debugbar docs scan at the framework docs"
```

---

### Task 8: doc-hub check in `check:maintainability` (rule 6 scopes)

**Files:**
- Modify: `scripts/check-maintainability.ts` (add `checkDocsHub`, call it from `runRules`, extend `runSelfTest` fixtures, update the success message)

**Interfaces:**
- Consumes: `docs/README.md` from Task 2 (the map rows are backticked `docs/…` paths).
- Produces: a new diag `doc-hub:missing` ("not listed in docs/README.md doc map") for every `docs/*.md` / `docs/ai/*.md` (except `docs/README.md` and `docs/ai/TREE.md`) absent from the hub.

- [ ] **Step 1: Write the failing self-test expectations**

Extend `runSelfTest` in `scripts/check-maintainability.ts`:

- In the dirty-tree section, after the existing `docs/ai/wrapped.md` fixture line, add a hub that does NOT list the stray docs:

```ts
writeFixture(join(dirty, "docs/README.md"), "# hub\n\n| Path | Topic |\n| --- | --- |\n");
```

- Add `"doc-hub:missing"` to the `want` set.
- In the clean-tree section, write a hub that DOES list the clean doc:

```ts
writeFixture(
  join(clean, "docs/README.md"),
  "# hub\n\n| Path | Topic |\n| --- | --- |\n| `docs/ai/ok.md` | ok |\n",
);
```

- Update the final success message: `"all 8 rules fire"` → `"all 9 rules fire"`.

- [ ] **Step 2: Run the self-test to verify it fails**

Run: `bun run check:maintainability -- --self-test`
Expected: FAIL — `doc-hub:missing` never fires on the dirty tree (rule not implemented), so the want-set assertion trips.

- [ ] **Step 3: Implement `checkDocsHub`**

Add next to `checkDocPathRefs`:

```ts
/**
 * Rule 6 (doc hub) — every docs/*.md and docs/ai/*.md (except README.md and
 * the generated TREE.md) must be listed in the docs/README.md doc map
 * (backticked path tokens). The map is the single source of truth; a doc
 * nobody can find is a doc that rots.
 */
const checkDocsHub = (root: string, diags: Diag[]): void => {
  const hubPath = join(root, "docs", "README.md");
  let hub = "";
  try {
    hub = readFileSync(hubPath, "utf8");
  } catch {
    hub = ""; // no hub at all → every doc is missing
  }
  const listed = new Set<string>();
  for (const token of docPathTokens(hub)) {
    if (token.startsWith("docs/") && token.endsWith(".md")) listed.add(token);
  }
  const scopes: Array<{ dir: string; prefix: string }> = [
    { dir: join(root, "docs"), prefix: "docs" },
    { dir: join(root, "docs", "ai"), prefix: "docs/ai" },
  ];
  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;
    for (const name of readdirSync(scope.dir)) {
      if (!name.endsWith(".md")) continue;
      const rel = `${scope.prefix}/${name}`;
      if (rel === "docs/README.md" || rel === "docs/ai/TREE.md") continue;
      if (!listed.has(rel)) {
        diags.push({
          path: rel,
          rule: "doc-hub:missing",
          detail: "not listed in docs/README.md doc map",
        });
      }
    }
  }
};
```

Find where `checkDocPathRefs(root, diags)` is invoked inside `runRules` and call `checkDocsHub(root, diags)` next to it.

- [ ] **Step 4: Run the self-test to verify it passes**

Run: `bun run check:maintainability -- --self-test`
Expected: PASS ("all 9 rules fire"); dirty tree fires `doc-hub:missing`, clean tree stays clean.

- [ ] **Step 5: Run the check against the real repo**

Run: `bun run check:maintainability`
Expected: PASS — the Task 2 hub lists every durable doc.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-maintainability.ts
git commit -m "feat(scripts): doc-hub rule — every docs/*.md and docs/ai/*.md must be listed in the docs/README.md map"
```

---

### Task 9: Doc tables + changelog

**Files:**
- Modify: `docs/debugbar.md` (UI tour Docs panel, endpoints table, deep links, KT cross-link note)
- Modify: `CHANGELOG.md` (one `[Unreleased]` entry)
- Modify: `docs/ai/TREE.md` — regenerated via `bun run gen:ai-map` only if it drifted (it may still cite deleted superpowers files)

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: docs that match the shipped behavior (docs discipline).

- [ ] **Step 1: Update `docs/debugbar.md`**

- UI tour, after the KT bullet (`- **KT** — …`), add:

```markdown
- **Docs** — the repository's documentation rendered inside the dashboard:
  a sidebar inventory (same scan as KT — `debugbar({ docsPaths })`) and a
  content pane showing the selected doc (sanitized server-rendered HTML, or a
  plain-markdown fallback). Deep links: `#/docs`, `#/docs/<path>` (e.g.
  `#/docs/docs/router.md`).
```

- API endpoints table (after the `GET /api/kt` row):

```markdown
| `GET /api/docs` | docs inventory; `?path=<relpath>` returns one rendered doc (404 for unknown/traversal paths) |
```

- Deep links list (line ~772): add `#/docs`, `#/docs/<path>`.
- In the "What you get" table, add a row:

```markdown
| **Docs panel** | The repo's markdown docs rendered in the dashboard — enter the framework docs without leaving the debugbar; cross-links from the KT page. |
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Under the single `[Unreleased]` heading, add:

```markdown
- **Docs hub** — `docs/README.md` is now the single entry point: a doc map
  with audience + maturity per document, reading paths per persona, artifact
  rules and the "adding a doc" governance; `check:maintainability` enforces
  it (`doc-hub:missing`). Completed `docs/superpowers` process artifacts were
  deleted per the plan rule. `README.md`/`AGENTS.md`/`RULES.md` now point at
  the hub.
- **Debugbar Docs panel** — new `Docs` view (`#/docs`, `#/docs/<path>`) and
  `GET /api/docs`: the repository's docs rendered inside the debugbar via the
  KT docs scan (reads confined to the inventory, sanitized HTML). The
  reference app scans the framework docs (`docsPaths`).
```

- [ ] **Step 3: Regenerate the AI scaffold map**

Run: `bun run gen:ai-map` — then check whether `docs/ai/TREE.md` still cites `docs/superpowers/plans/*` (deleted in Task 1). Regenerate restores consistency automatically. Commit if changed.

- [ ] **Step 4: Verify quick gate**

Run: `bun run verify:quick`
Expected: PASS (typecheck, typecheck:cli, lint, jsdoc:check:strict).

- [ ] **Step 5: Commit**

```bash
git add docs/debugbar.md CHANGELOG.md docs/ai/TREE.md
git commit -m "docs(debugbar): Docs panel + /api/docs endpoint documented; changelog entry; regen AI map"
```

---

### Task 10: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full checks**

Run in order:

```bash
bun run verify:quick
bun run check:maintainability
bun run check:debug-ui
bunx vitest run packages/core/test/debug-docs.test.ts packages/core/test/debug-ui-router.test.ts
```

Expected: all PASS.

- [ ] **Step 2: End-to-end smoke of the Docs panel**

```bash
DEBUG=true bun run dev
```
Then in a browser (or via curl) verify:
- `GET /__debugbar/#/docs` lists the sidebar from `/api/docs` (repo README first).
- `#/docs/docs/router.md` renders content (server HTML when Bun.markdown is available; markdown fallback otherwise).
- `#/docs/docs/README.md` renders the hub.

Then kill the dev server and run:

```bash
bun run smoke && bun run smoke:fallback
```

Expected: PASS.

- [ ] **Step 3: Cross-package tests**

Run: `bun run test:parallel`
Expected: PASS (core/compiler/shared/cli/mcp suites; the extended debug suites are green from earlier tasks).

- [ ] **Step 4: Final status**

Confirm `git status --short` shows no stray files (the two live process docs — this plan and the design spec — stay in `docs/superpowers/` until the work lands, then Task 1's deletion rule applies to them too, with their conclusion folded into `docs/debugbar.md` / `CHANGELOG.md`).