# D-016 · The user-facing docs are a VitePress site in `site/`, deployed to GitHub Pages

- Status: accepted
- Context: the repo docs (`docs/*.md`) are written contributor-first —
  accurate, but dense, and only reachable by reading markdown on GitHub. A
  newcomer had no guided surface: no landing page, no learning path, no
  rendered examples or interactive demos. The docs-governance gates
  (`check:maintainability` doc-hub rule, `check:layers` TIER table, knip
  workspaces) each constrain where new content can live.

- Decision: the user-facing documentation site is a **self-contained
  VitePress project at root-level `site/`**, deployed to GitHub Pages
  (`https://axylabs.github.io/ignex/`) by `.github/workflows/docs.yml`
  (push to `main` affecting `site/**`, PRs get a build-only check). Site
  content is written learner-first and stays **outside** the governed
  `docs/` tree, which remains the system-of-record for contributor/agent
  docs — the "one owner per topic" rule is honored by splitting audiences,
  not duplicating topics: guides on the site teach; `docs/*.md` specify.
  The site keeps its **own lockfile** (`site/bun.lock`, vitepress + vue
  only) so the root workspace lockfile, the `bun audit` gate, knip, and
  the api-surface freeze are untouched. The demo API explorer serves a
  **committed snapshot** (`site/public/demo/openapi.json`) of the
  reference app's compiler-generated spec; regenerate by re-running
  `bun run build` and copying the artifact. Convenience scripts
  (`docs:dev`, `docs:build`, `docs:preview`) wrap the site toolchain from
  the root. Lint still covers the site's TS (`config.mts`, theme) in house
  biome style; generated/cache dirs are excluded from biome + oxlint.

- Consequences: docs surface gains a rendered, searchable site with dark
  mode and local search; contributors keep `docs/` unchanged as the source
  of truth — site guides are allowed to be friendlier restatements of the
  same behavior, and a factual conflict is always resolved in favor of
  `docs/`. The CI surface grows one workflow (build on PRs, deploy on
  `main`); Pages must stay enabled with `build_type: workflow`. The
  `openapi.json` snapshot can go stale relative to the reference app —
  acceptable for a demo (the explorer labels it a snapshot); refresh it
  when route shapes change materially.

- Verification: `site/.vitepress/config.mts` (base `/ignex/`), `.github/workflows/docs.yml`,
  root `package.json` `docs:*` scripts, `bun run docs:build` succeeds with
  no dead links, `bun run check:consistency` + `bun run check:maintainability` stay green,
  `bun run check:layers` + `bun run check:dead` unaffected (site/ is outside `packages/`).
