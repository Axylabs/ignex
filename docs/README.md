# ignex documentation

Welcome. This page is the map: what each document is for, who it's written for,
and how settled it is. If you'd rather be pointed somewhere, pick the path below
that sounds like you.

## Start here

**I want to build an app.** [Getting started](getting-started.md) goes from an
empty folder to a running API. Keep [Cookbook](cookbook.md) open in a second tab
— that's where the recipes live (auth, sessions, jobs, SSE, caching, and so on).

**I want to understand how it works.** [Architecture](architecture.md) tours the
monorepo and the compilation pipeline; [Router](router.md) walks the request
lifecycle. `docs/decisions/` explains *why* the tricky calls were made.

**I'm working on ignex itself.** [Adding a feature](adding-a-feature.md) is the
workflow, [Stability](stability.md) is the risk and gate map, and
[AGENTS.md](../AGENTS.md) carries the onboarding (run it, the three-layer mental
model, three exercises, cross-repo `bun link`).

Working with an AI agent? Point it at [AGENTS.md](../AGENTS.md) and
[RULES.md](../RULES.md) first; the skills under `.agents/skills/` are the
per-area runbooks.

## The map

Every topic has exactly one owner document — if something belongs to a doc that
already exists, extend that doc rather than starting a sibling.

- **Audience** — `Users` build apps with ignex, `Contributors` work in this repo,
  `Agents` are tooling/agents operating on the repo.
- **Maturity** — `stable` won't change casually, `evolving` moves with the code,
  `reference` is tables and contracts to look up.

| Path | Topic | Audience | Maturity |
| --- | --- | --- | --- |
| `docs/architecture.md` | Architecture / monorepo layout | Contributors, Agents | stable |
| `docs/router.md` | Router: interpreted `createRouter` + AOT file routing | Users, Contributors | stable |
| `docs/native-acceleration.md` | castrum bridge, SELECTION, pure-TS fallbacks, Bun-builtin matrix | Contributors | stable |
| `docs/perf-methodology.md` | Measuring perf: methodology, cost budget, ruled-out hypotheses | Contributors | reference |
| `docs/comparison-bench.md` | Cross-framework comparison bench | Contributors | reference |
| `docs/compatibility.md` | Compatibility with nova / ninox / castrum | Users, Contributors | stable |
| `docs/sdk.md` | SDK generation and distribution | Users, Contributors | stable |
| `docs/debugbar.md` | Debugbar + observatory (dashboard, driver protocol, UI design system, Docs panel) | Users, Contributors | evolving |
| `docs/drivers.md` | DB drivers (sqlite / mongo / drizzle) | Users | stable |
| `docs/deployment.md` | Deployment (Bun binary, Docker, proxies) | Users | stable |
| `docs/getting-started.md` | First-run tutorial | Users | stable |
| `docs/cookbook.md` | Task recipes | Users | evolving |
| `docs/errors.md` | Error taxonomy, failure reports, correlation | Users, Contributors | evolving |
| `docs/adding-a-feature.md` | Adding a feature (workflow + gates) | Contributors | stable |
| `docs/release-process.md` | Release checklist + version files | Contributors | stable |
| `docs/stability.md` | Known risks, gate matrix, hardening guards, further work | Contributors, Agents | evolving |
| `docs/ai/maintaining.md` | Symptom → origin module → pinning test | Contributors, Agents | evolving |

`docs/decisions/` (D-001…) holds accepted design decisions, each with a
Verification clause — read the numbered entry when a design choice is in play.
`RULES.md`, `AGENTS.md`, `CONTRIBUTING.md` and `CHANGELOG.md` at the repo root
aren't part of the map: they're the rules, the agent how-to, the contribution
workflow, and the versioned log.

## Ongoing reading paths

- **Framework user** (build an app): [getting-started](getting-started.md) →
  [router](router.md) → [cookbook](cookbook.md) → [errors](errors.md) →
  [deployment](deployment.md) → [debugbar](debugbar.md) → [drivers](drivers.md).
- **Contributor** (work in this repo): [AGENTS.md](../AGENTS.md) §First day →
  [adding-a-feature](adding-a-feature.md) → [architecture](architecture.md) → the
  `.agents/skills/` runbook for your area → [release-process](release-process.md).
- **AI agent**: [AGENTS.md](../AGENTS.md) (commands, mental model, gates) →
  [RULES.md](../RULES.md) → the debugger's own Docs and KT panels at
  `/__debugbar/#/docs` and `/__debugbar/#/kt` (rendered from the same scan).

## Artifact directories

- `docs/ai/` — agent scaffolding: [maintaining.md](ai/maintaining.md), the
  symptom → origin module → pinning test lookup.
- `docs/decisions/` — ADRs (D-001…): one template, one numbered entry per
  accepted design choice, each with a Verification clause.

Process artifacts (design specs, execution plans) are not kept as docs: when the
work lands, fold the still-live conclusion into the owning doc or
`CHANGELOG.md`. `git log` is the archive.

## Adding a doc

Every new doc gets a row in the map above, or `bun run check:maintainability`
fails (`doc-hub:missing`). Prefer extending a doc over creating a sibling. Never
delete or rename a doc without grepping for references (`docs/`, `AGENTS.md`,
`RULES.md`, `.agents/skills/`, source comments, `CHANGELOG.md`,
`.github/workflows/`) — and fix every hit, so no link is left dangling.
