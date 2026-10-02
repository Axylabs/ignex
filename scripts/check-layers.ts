/**
 * @fileoverview Layers gate — the architecture fitness function for the ignex
 * monorepo (see `docs/decisions/014-enforced-layers.md`).
 *
 * The monorepo's dependency rule has been prose in `docs/architecture.md`
 * since the beginning:
 *
 *     shared ← native ← core ← compiler ← cli
 *
 * Prose does not fail a build, so a lower tier could quietly start importing a
 * higher one and nobody noticed until a bundler (or a human) did. This gate
 * makes the rule executable: it reads every import in the package `src` trees,
 * checks it against the tier table, and fails on an upward edge (unless it is
 * a documented exception) or on an import cycle inside a package.
 *
 * Usage:
 *   bun scripts/check-layers.ts             # gate (exit 1 on violation)
 *   bun scripts/check-layers.ts --report    # the layer table + who imports whom
 *   bun scripts/check-layers.ts --mermaid   # the graph as a mermaid diagram
 *   bun scripts/check-layers.ts --self-test # fixture suite for the rule engine
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Tier per workspace package *directory*. Lower tiers must never import higher
 * ones. `test-utils` and `shared` are the floor; `app` is the reference
 * application and may use everything below it.
 */
const TIER: Record<string, number> = {
  "test-utils": 0,
  shared: 0,
  native: 1,
  core: 2,
  compiler: 3,
  cli: 4,
  mcp: 4,
  create: 4,
  app: 5,
};

/**
 * Deliberate, documented upward/same-tier edges. Anything pointing up a tier
 * that is not listed here is a violation.
 */
const EXCEPTIONS: ReadonlyArray<{
  from: string;
  to: string;
  /** When true the edge is only legal as a dynamic `import()`. */
  dynamic?: boolean;
  why: string;
}> = [
  {
    from: "cli",
    to: "mcp",
    dynamic: true,
    why: "optional peer — `ignex mcp` lazily import()s @ignex/mcp so the MCP SDK stays out of every scaffold",
  },
  {
    from: "mcp",
    to: "cli",
    why: "@ignex/mcp reuses the CLI's pure route-file parser (`@ignex/cli/route`)",
  },
];

const LAYER_DOC = "docs/architecture.md (The one-way dependency rule)";

/** A single import/export statement that points at a relative or @ignex specifier. */
interface Ref {
  file: string;
  line: number;
  spec: string;
  dynamic: boolean;
  typeOnly: boolean;
}

interface Edge {
  from: string;
  to: string;
  refs: Ref[];
}

/** Only relative and workspace specifiers matter — bare/`node:`/`bun:` are external. */
const FROM_RE = /\bfrom\s*"((?:\.\.?\/|@ignex\/)[^"]+)"/g;
const DYN_RE = /\bimport\s*\(\s*"((?:\.\.?\/|@ignex\/)[^"]+)"/g;
const SIDE_RE = /\bimport\s+"((?:\.\.?\/|@ignex\/)[^"]+)"/g;

const rel = (p: string): string => relative(ROOT, p).replace(/\\/g, "/");

/** Is the statement ending at `at` a type-only import/export? */
const isTypeOnly = (src: string, at: number): boolean => {
  const head = src.slice(Math.max(0, at - 240), at);
  const last = Math.max(head.lastIndexOf("import"), head.lastIndexOf("export"));
  if (last < 0) return false;
  const clause = head.slice(last);
  return /^(import|export)\s+type\b/.test(clause) || /\{\s*type\s/.test(clause);
};

/** `packages/<dir>/src/...` → `<dir>`; null when the path is outside the workspace. */
const dirOf = (file: string): string | null => {
  const parts = rel(file).split("/");
  return parts[0] === "packages" && parts[1] ? (parts[1] ?? null) : null;
};

const pkgNameToDir = new Map<string, string>();
const dirToName = new Map<string, string>();

/** Populate the name↔dir maps from every workspace manifest. */
const discoverPackages = (): void => {
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(ROOT, "packages", entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
    if (!name) continue;
    pkgNameToDir.set(name, entry.name);
    dirToName.set(entry.name, name);
  }
};

/** Every `.ts`/`.tsx` file in each workspace package's `src` tree. */
const collectFiles = (): string[] => {
  const out: string[] = [];
  for (const dir of pkgNameToDir.values()) {
    const src = join(ROOT, "packages", dir, "src");
    if (!existsSync(src)) continue;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (!["node_modules", "dist", ".git"].includes(e.name)) walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          out.push(p);
        }
      }
    };
    walk(src);
  }
  return out;
};

/** Resolve a relative specifier to an existing source file. */
const resolveFile = (file: string, spec: string): string | null => {
  const base = resolve(dirname(file), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/** The workspace package directory a specifier points at, or null if external. */
const specDir = (file: string, spec: string): string | null => {
  if (spec.startsWith("@ignex/")) {
    const name = spec.split("/").slice(0, 2).join("/");
    return pkgNameToDir.get(name) ?? null;
  }
  const target = resolveFile(file, spec);
  return target ? dirOf(target) : null;
};

/** Read every relevant import out of the source tree. */
const scan = (files: string[]): Ref[] => {
  const refs: Ref[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lineAt = (i: number): number => src.slice(0, i).split("\n").length;
    const push = (spec: string, i: number, dynamic: boolean, typeOnly: boolean): void => {
      refs.push({ file, line: lineAt(i), spec, dynamic, typeOnly });
    };
    for (const m of src.matchAll(FROM_RE))
      push(m[1] ?? "", m.index, false, isTypeOnly(src, m.index));
    for (const m of src.matchAll(DYN_RE)) push(m[1] ?? "", m.index, true, false);
    for (const m of src.matchAll(SIDE_RE)) push(m[1] ?? "", m.index, false, false);
  }
  return refs;
};

/** Group refs into workspace-package edges; collect external `@ignex/*` peers seen. */
const aggregate = (refs: Ref[]): { edges: Edge[]; external: Map<string, number> } => {
  const byKey = new Map<string, Edge>();
  const external = new Map<string, number>();
  for (const ref of refs) {
    const from = dirOf(ref.file);
    if (!from) continue;
    if (ref.spec.startsWith("@ignex/")) {
      const name = ref.spec.split("/").slice(0, 2).join("/");
      if (!pkgNameToDir.has(name)) {
        external.set(name, (external.get(name) ?? 0) + 1);
        continue;
      }
    }
    const to = specDir(ref.file, ref.spec);
    if (!to || to === from) continue;
    const key = `${from}|${to}`;
    const edge = byKey.get(key) ?? { from, to, refs: [] };
    edge.refs.push(ref);
    byKey.set(key, edge);
  }
  return { edges: [...byKey.values()], external };
};

/** Is this particular reference covered by a documented exception? */
const exceptionCovers = (edge: Edge, ref: Ref): boolean =>
  EXCEPTIONS.some(
    (e) => e.from === edge.from && e.to === edge.to && (e.dynamic ? ref.dynamic : true),
  );

/**
 * Edges that no exception covers: anything upward, plus same-tier edges (a
 * peer dependency is still a coupling decision and must be deliberate).
 */
const findViolations = (edges: Edge[]): { edge: Edge; refs: Ref[] }[] => {
  const out: { edge: Edge; refs: Ref[] }[] = [];
  for (const edge of edges) {
    const from = TIER[edge.from];
    const to = TIER[edge.to];
    if (from === undefined || to === undefined) continue; // reported separately
    if (to < from) continue; // strictly downward — always allowed
    const refs = edge.refs.filter((r) => !exceptionCovers(edge, r));
    if (refs.length > 0) out.push({ edge, refs });
  }
  return out;
};

/** Adjacency of resolved, non-dynamic, non-type-only relative imports. */
const relativeGraph = (files: string[], refs: Ref[]): Map<string, string[]> => {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.dynamic || ref.typeOnly || ref.spec.startsWith("@ignex/")) continue;
    const target = resolveFile(ref.file, ref.spec);
    if (!target || !known.has(target)) continue;
    const list = graph.get(ref.file) ?? [];
    list.push(target);
    graph.set(ref.file, list);
  }
  return graph;
};

/** Tarjan SCC over the relative-import graph; returns components with >1 file. */
const findCycles = (files: string[], refs: Ref[]): string[][] => {
  const graph = relativeGraph(files, refs);
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const sccs: string[][] = [];

  /** `low[v] = min(low[v], candidate)`. */
  const lower = (v: string, candidate: number | undefined): void => {
    low.set(v, Math.min(low.get(v) ?? 0, candidate ?? 0));
  };

  /** Pop everything down to (and including) `root` into one component. */
  const popComponent = (root: string): string[] => {
    const component: string[] = [];
    let w: string | undefined = stack.pop();
    while (w !== undefined) {
      onStack.delete(w);
      component.push(w);
      if (w === root) break;
      w = stack.pop();
    }
    return component;
  };

  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        lower(v, low.get(w));
      } else if (onStack.has(w)) {
        lower(v, idx.get(w));
      }
    }
    if (low.get(v) !== idx.get(v)) return;
    const component = popComponent(v);
    if (component.length > 1) sccs.push(component);
  };

  for (const file of files) if (!idx.has(file)) strong(file);
  return sccs;
};

/** `tier  package  workspace deps`, sorted low → high. */
const report = (edges: Edge[], external: Map<string, number>, cycles: string[][]): void => {
  const deps = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = deps.get(edge.from) ?? [];
    list.push(edge);
    deps.set(edge.from, list);
  }
  console.log("Layer table — lower tiers must never import higher ones (D-014)\n");
  const dirs = [...dirToName.keys()].sort(
    (a, b) => (TIER[a] ?? 99) - (TIER[b] ?? 99) || a.localeCompare(b),
  );
  for (const dir of dirs) {
    const tier = TIER[dir] ?? "?";
    const list = (deps.get(dir) ?? [])
      .map((e) => {
        const dyn = e.refs.every((r) => r.dynamic) ? " (dynamic)" : "";
        return `${dirToName.get(e.to)} ×${e.refs.length}${dyn}`;
      })
      .sort()
      .join(", ");
    console.log(
      `  tier ${String(tier).padEnd(2)} ${(dirToName.get(dir) ?? dir).padEnd(18)} ${list || "—"}`,
    );
  }
  console.log("\n  documented exceptions:");
  for (const e of EXCEPTIONS) {
    console.log(
      `    ${dirToName.get(e.from)} → ${dirToName.get(e.to)}${e.dynamic ? " (dynamic)" : ""} — ${e.why}`,
    );
  }
  if (external.size > 0) {
    console.log(
      `\n  external @ignex peers (not workspace packages, unconstrained): ${[...external.keys()].sort().join(", ")}`,
    );
  }
  console.log(
    `\n  ${cycles.length === 0 ? "no import cycles" : `${cycles.length} import cycle(s) — run the gate for details`}`,
  );
};

/** Minimal mermaid flow chart; dashed = dynamic-only edge. */
const mermaid = (edges: Edge[]): void => {
  console.log("flowchart TD");
  for (const dir of [...dirToName.keys()].sort()) {
    console.log(`  ${dir}["${dirToName.get(dir)}"]`);
  }
  for (const edge of edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )) {
    const arrow = edge.refs.every((r) => r.dynamic) ? "-.->" : "-->";
    console.log(`  ${edge.from} ${arrow} ${edge.to}`);
  }
};

const selfTest = (): void => {
  const fail = (m: string): never => {
    console.error(`\u2716 self-test: ${m}`);
    process.exit(1);
  };
  // isTypeOnly: inline `type` markers count, a plain value import does not.
  if (!isTypeOnly('import type { A } from "x";', 27)) fail("import type missed");
  if (!isTypeOnly('import { type A, b } from "x";', 30)) fail("inline type missed");
  if (isTypeOnly('import { a } from "x";', 22)) fail("value import flagged as type");
  // Tier rule: down is fine, up is not.
  const up: Edge = { from: "core", to: "compiler", refs: [] };
  const down: Edge = { from: "core", to: "native", refs: [] };
  const staticRef = (ref: Partial<Ref>): Ref => ({
    file: "packages/core/src/x.ts",
    line: 1,
    spec: "@ignex/compiler",
    dynamic: false,
    typeOnly: false,
    ...ref,
  });
  if (findViolations([down]).length !== 0) fail("downward edge flagged");
  if (findViolations([{ ...up, refs: [staticRef({})] }]).length !== 1) fail("upward edge missed");
  // The sanctioned pair: cli→mcp only as a dynamic import.
  const cliToMcp = (dynamic: boolean): Edge => ({
    from: "cli",
    to: "mcp",
    refs: [staticRef({ spec: "@ignex/mcp", dynamic })],
  });
  if (findViolations([cliToMcp(true)]).length !== 0) fail("dynamic peer exception missed");
  if (findViolations([cliToMcp(false)]).length !== 1) fail("static peer import should violate");
  // specDir: external peers resolve to null (unconstrained).
  if (specDir("packages/core/src/x.ts", "@ignex/nova/events") !== null)
    fail("external peer not skipped");
  console.log("\u2714 check-layers self-test passed");
};

const main = (): void => {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  discoverPackages();
  const files = collectFiles();
  const refs = scan(files);
  const { edges, external } = aggregate(refs);
  const cycles = findCycles(files, refs);

  if (process.argv.includes("--mermaid")) {
    mermaid(edges);
    return;
  }
  if (process.argv.includes("--report")) {
    report(edges, external, cycles);
    return;
  }

  const violations = findViolations(edges);
  const unknown = [...dirToName.keys()].filter((d) => TIER[d] === undefined);

  if (violations.length === 0 && cycles.length === 0 && unknown.length === 0) {
    console.log(
      `\u2714 layers: ${dirToName.size} packages, ${edges.length} edges, ${files.length} files — one-way rule holds`,
    );
    return;
  }

  console.error(
    `\u2716 layers: ${violations.length + cycles.length + unknown.length} problem(s)\n`,
  );
  for (const { edge, refs: bad } of violations) {
    console.error(
      `  ${dirToName.get(edge.from)} → ${dirToName.get(edge.to)}  (${bad.length} import${bad.length === 1 ? "" : "s"})`,
    );
    for (const r of bad.slice(0, 3)) {
      console.error(
        `      ${rel(r.file)}:${r.line}  ${r.dynamic ? "import()" : "import"} ${r.spec}`,
      );
    }
    console.error(
      `      A tier-${TIER[edge.from]} package may not depend on tier-${TIER[edge.to]}.`,
    );
    console.error(
      `      Move the shared piece down a tier, invert the dependency, or add a documented`,
    );
    console.error(`      exception in scripts/check-layers.ts (and ${LAYER_DOC}).\n`);
  }
  for (const cycle of cycles) {
    console.error(`  import cycle (${cycle.length} files)`);
    for (const f of cycle) console.error(`      ${rel(f)}`);
    console.error(`      Break the loop by moving the shared type/helper into its own module.\n`);
  }
  for (const dir of unknown) {
    console.error(`  packages/${dir} has no tier — add it to TIER in scripts/check-layers.ts.\n`);
  }
  process.exit(1);
};

main();
