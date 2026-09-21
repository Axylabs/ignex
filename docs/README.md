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
| `docs/debugbar-ui.md` | Debugbar UI design system & style guide (tokens, components, a11y) | Contributors | evolving |
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