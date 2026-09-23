/**
 * @fileoverview Maintainability gate — the mechanical part of the
 * "intern-maintainable ignex" system (spec:
 * `docs/superpowers/specs/2026-09-20-maintainability-design.md`).
 *
 * Enforces, for every src file under the packages src trees:
 *   1. size-cap    — files over `maxLines` must be allowlisted in
 *                    `maintainability.json` and must not grow past their
 *                    recorded count (entries are shrink-only; a stale entry —
 *                    file gone or under the cap — is an error).
 *   2. debt-markers— no `TODO|FIXME|HACK|XXX` in src.
 *   3. orphan-dirs — no `.gen-debug-ui-*` build leftovers.
 *   4. duplicates — no exact-duplicate src files (normalized).
 *   5. fileoverview— files over `fileoverviewMinLines` start with a
 *                    `@fileoverview` JSDoc block.
 *   6. doc-refs — backticked repo paths cited in `docs/decisions/*.md`
 *                    Verification: lines, the skills runbooks (`SKILL.md`
 *                    under `.agents/skills/`), and `docs/ai/*.md` must exist
 *                    (doc-rot guard). Glob
 *                    tokens (`packages/*`, `docs/*.md`) and cross-repo
 *                    references are skipped.
 *   7. doc-hub  — every `docs/*.md` and `docs/ai/*.md` (except the hub
 *                    `docs/README.md`) must be listed in the `docs/README.md`
 *                    doc map.
 *
 * Usage:
 *   bun scripts/check-maintainability.ts            # gate (exit 1 on violation)
 *   bun scripts/check-maintainability.ts --report   # print current line counts
 *   bun scripts/check-maintainability.ts --self-test# fixture suite for every rule
 *   bun scripts/check-maintainability.ts --root <dir>  # target another tree
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface Entry {
  lines: number;
  rationale: string;
}
interface Config {
  maxLines: number;
  fileoverviewMinLines: number;
  knownOver: Record<string, Entry>;
  ignoreGlobs: RegExp[];
}
type Diag = { path: string; rule: string; detail?: string };

const SELF_TEST_ROOT = "/tmp/opencode";

const globToRegExp = (glob: string): RegExp => {
  const re = glob
    .split("/")
    .map((part) => {
      if (part === "**") return ".*";
      return part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    })
    .join("/");
  return new RegExp(`^${re}$`);
};

const loadConfig = (root: string): Config => {
  const raw = JSON.parse(readFileSync(join(root, "maintainability.json"), "utf8")) as Omit<
    Config,
    "ignoreGlobs"
  > & {
    ignoreGlobs: string[];
  };
  return { ...raw, ignoreGlobs: raw.ignoreGlobs.map((g) => globToRegExp(g)) };
};

/** Every src .ts under the packages src trees, minus ignored globs. */
const collectSrcFiles = (root: string, cfg: Config): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          ["node_modules", "dist", ".git"].includes(entry.name) ||
          entry.name.startsWith(".gen-debug-ui-")
        )
          continue;
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const rel = p.slice(root.length + 1).replace(/\\/g, "/");
        if (!rel.includes("/src/")) continue;
        if (cfg.ignoreGlobs.some((g) => g.test(rel))) continue;
        out.push(p);
      }
    }
  };
  walk(join(root, "packages"));
  return out;
};

const lineCount = (p: string): number => readFileSync(p, "utf8").split("\n").length;

const firstDocBlock = (src: string): string | null => src.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? null;

const normalize = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");

const posix = (p: string): string => p.replace(/\\/g, "/");

/** Backticked tokens in a line that look like repo paths (whitespace-normalized; globs skipped). */
const docPathTokens = (line: string): string[] => {
  const out: string[] = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const token = (m[1] ?? "").replace(/\s+/g, "");
    if (!token) continue;
    if (/[*?]/.test(token)) continue; // intentional glob (packages/*/test), not a path
    if (
      !/^(?:packages|scripts|docs|\.agents)\//.test(token) &&
      !["RULES.md", "AGENTS.md", "maintainability.json"].includes(token)
    )
      continue;
    out.push(token);
  }
  return out;
};

/** Check one doc file's backticked repo-path citations against the filesystem. */
const checkDocFileRefs = (
  src: string,
  verificationOnly: boolean,
  root: string,
  relPath: string,
  diags: Diag[],
): void => {
  const missing = (token: string): void => {
    diags.push({
      path: relPath,
      rule: "doc-ref:dangling",
      detail: `cites missing path \`${token}\``,
    });
  };
  if (verificationOnly) {
    for (const line of src.split("\n")) {
      const body = line.trim().replace(/^-\s+/, "");
      if (!body.startsWith("Verification:")) continue;
      for (const token of docPathTokens(line)) {
        if (!existsSync(join(root, token))) missing(token);
      }
    }
    return;
  }
  // Whole-file scan so a backticked path wrapped across two lines is still
  // captured (docPathTokens normalizes whitespace).
  for (const token of docPathTokens(src)) {
    if (!existsSync(join(root, token))) missing(token);
  }
};

/** Rule 6 — every repo path cited by decisions / skills / docs-ai must exist. */
const checkDocPathRefs = (root: string, diags: Diag[]): void => {
  const scopes: Array<{
    dir: string;
    relPrefix: string;
    filter: (name: string) => boolean;
    verificationOnly: boolean;
  }> = [
    // docs/decisions/*.md — Verification: lines only (established contract).
    {
      dir: join(root, "docs", "decisions"),
      relPrefix: "docs/decisions",
      filter: (n) => n.endsWith(".md"),
      verificationOnly: true,
    },
    // Skills runbooks (SKILL.md under .agents/skills/) — all lines.
    {
      dir: join(root, ".agents", "skills"),
      relPrefix: ".agents/skills",
      filter: (n) => n === "SKILL.md",
      verificationOnly: false,
    },
    // docs/ai/*.md — all lines.
    {
      dir: join(root, "docs", "ai"),
      relPrefix: "docs/ai",
      filter: (n) => n.endsWith(".md"),
      verificationOnly: false,
    },
  ];

  for (const scope of scopes) {
    if (!existsSync(scope.dir)) continue;
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
          walk(p, relPath);
        } else if (scope.filter(entry.name)) {
          checkDocFileRefs(readFileSync(p, "utf8"), scope.verificationOnly, root, relPath, diags);
        }
      }
    };
    walk(scope.dir, scope.relPrefix);
  }
};

/**
 * Rule 7 (doc hub) — every `docs/*.md` and `docs/ai/*.md` (except the hub
 * itself) must be listed in the `docs/README.md`
 * doc map (backticked path tokens). The map is the single source of truth; a
 * doc nobody can find is a doc that rots.
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
      if (rel === "docs/README.md") continue;
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

/** Rule 3 — no `.gen-debug-ui-*` build leftovers under `packages`. */
const checkOrphanDirs = (root: string, diags: Diag[]): void => {
  const rel = (d: string): string => posix(d.slice(root.length + 1));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".gen-debug-ui-")) {
        diags.push({
          path: join(rel(dir), entry.name),
          rule: "orphan-gen-dir",
          detail: "leftover from a SIGINT-killed gen-debug-ui run",
        });
      } else if (![".git", "node_modules", "dist"].includes(entry.name)) {
        walk(join(dir, entry.name));
      }
    }
  };
  walk(join(root, "packages"));
};

/** Rules 1 (size-cap), 2 (debt-markers), 5 (fileoverview) for one file. */
const checkFileRules = (
  r: string,
  src: string,
  lines: number,
  cfg: Config,
  diags: Diag[],
): void => {
  // Rule 2 — debt markers.
  if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(src)) {
    diags.push({ path: r, rule: "debt-marker", detail: "TODO|FIXME|HACK|XXX found in src" });
  }

  // Rule 1 — size cap (shrink-only allowlist).
  const entry = cfg.knownOver[r];
  if (lines > cfg.maxLines) {
    if (!entry) {
      diags.push({
        path: r,
        rule: "size-cap:not-listed",
        detail: `${lines} lines > ${cfg.maxLines}; add a shrink-only entry to maintainability.json`,
      });
    } else if (lines > entry.lines) {
      diags.push({
        path: r,
        rule: "size-cap:grew",
        detail: `${lines} lines > recorded ${entry.lines} (entries are shrink-only)`,
      });
    }
  } else if (entry) {
    diags.push({
      path: r,
      rule: "size-cap:stale",
      detail: "entry exists but file is gone or under the cap — remove it",
    });
  }

  // Rule 5 — @fileoverview on cap-size files.
  if (lines > cfg.fileoverviewMinLines) {
    const block = firstDocBlock(src);
    if (!block?.includes("@fileoverview")) {
      diags.push({
        path: r,
        rule: "missing-fileoverview",
        detail: `${lines} lines > ${cfg.fileoverviewMinLines}; start the file with an @fileoverview JSDoc block`,
      });
    }
  }
};

/**
 * Run every rule against `root`; returns diagnostics (empty = pass).
 * Rules 6/7/3 run at the tree level; 1/2/5 per file; 4 across all files.
 */
const runRules = (root: string): Diag[] => {
  const cfg = loadConfig(root);
  const diags: Diag[] = [];
  const rel = (p: string): string => posix(p.slice(root.length + 1));

  checkDocPathRefs(root, diags);
  checkDocsHub(root, diags);
  checkOrphanDirs(root, diags);

  const files = collectSrcFiles(root, cfg);
  const hashes = new Map<string, string[]>();
  for (const p of files) {
    const src = readFileSync(p, "utf8");
    const r = rel(p);
    checkFileRules(r, src, lineCount(p), cfg, diags);

    // Rule 4 — exact duplicates (normalized).
    const h = createHash("sha256").update(normalize(src)).digest("hex");
    const list = hashes.get(h) ?? [];
    list.push(r);
    hashes.set(h, list);
  }
  for (const group of hashes.values()) {
    if (group.length > 1) {
      diags.push({
        path: group.join(" == "),
        rule: "duplicate-file",
        detail: "exact duplicate after comment/whitespace normalization",
      });
    }
  }

  return diags;
};

const report = (root: string): void => {
  const cfg = loadConfig(root);
  const files = collectSrcFiles(root, cfg)
    .map((p) => ({ p, lines: lineCount(p) }))
    .filter((f) => f.lines > cfg.maxLines)
    .sort((a, b) => b.lines - a.lines);
  for (const f of files)
    console.log(`${String(f.lines).padStart(4)}  ${posix(f.p.slice(root.length + 1))}`);
  console.log(`\n${files.length} file(s) over ${cfg.maxLines} lines`);
};

const writeFixture = (p: string, content: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const pad = (n: number, body: string): string => "// filler\n".repeat(n) + body;
const makeConfig = (knownOver: Record<string, { lines: number; rationale: string }>): string =>
  JSON.stringify(
    {
      maxLines: 400,
      fileoverviewMinLines: 400,
      knownOver,
      ignoreGlobs: ["**/*.config.ts", "**/.gen-debug-ui-*/**"],
    },
    null,
    2,
  );

const runSelfTest = (): void => {
  const base = mkdtempSync(join(SELF_TEST_ROOT, "maintainability-self-test-"));

  // ── Dirty tree: every rule must fire ───────────────────────────────────
  const dirty = join(base, "dirty");
  const dirtyCfg = makeConfig({
    "packages/a/src/big2.ts": { lines: 400, rationale: "grow fixture" },
    "packages/a/src/big3.ts": { lines: 430, rationale: "fileoverview fixture" },
    "packages/a/src/stale.ts": { lines: 100, rationale: "stale-entry fixture" },
  });
  writeFixture(join(dirty, "maintainability.json"), dirtyCfg);
  writeFixture(join(dirty, "packages/a/src/big.ts"), pad(401, "export const big = 1;\n"));
  writeFixture(join(dirty, "packages/a/src/big2.ts"), pad(405, "export const big2 = 1;\n"));
  writeFixture(join(dirty, "packages/a/src/big3.ts"), pad(430, "export const big3 = 1;\n"));
  writeFixture(
    join(dirty, "packages/a/src/todo.ts"),
    "// TODO: do the thing\nexport const t = 1;\n",
  );
  writeFixture(join(dirty, "packages/a/src/dup1.ts"), "export const d = 1;\n// comment\n");
  writeFixture(join(dirty, "packages/a/src/dup2.ts"), "export const d = 1;\n");
  writeFixture(join(dirty, "packages/a/src/stale.ts"), "export const s = 1;\n".repeat(100));
  mkdirSync(join(dirty, "packages", ".gen-debug-ui-fix"), { recursive: true });
  writeFixture(
    join(dirty, "docs/decisions/001-x.md"),
    "- Verification: `packages/a/src/nope.ts`\n",
  );
  // Rule 6 expanded scopes — a skill cite, a docs/ai cite, and a wrapped
  // (whitespace-normalized) cite all must fire doc-ref:dangling.
  writeFixture(join(dirty, ".agents/skills/z/SKILL.md"), "- Requires: `packages/a/src/nope.ts`\n");
  writeFixture(join(dirty, "docs/ai/scratch.md"), "- Uses: `scripts/nope.ts`\n");
  writeFixture(join(dirty, "docs/ai/wrapped.md"), "path `packages/a/src/\nwrap.ts` missing\n");
  // Glob tokens are skipped by design (they are not paths).
  writeFixture(join(dirty, "docs/ai/globs.md"), "covers `packages/*/test` and `docs/*.md`\n");
  // Doc-hub rule — a hub that lists no docs means every doc is missing from
  // the map (scratch/wrapped/globs must all fire doc-hub:missing).
  writeFixture(join(dirty, "docs/README.md"), "# hub\n\n| Path | Topic |\n| --- | --- |\n");

  const dirtyDiags = runRules(dirty);
  const got = new Set(dirtyDiags.map((d) => d.rule));
  const want = new Set([
    "size-cap:not-listed",
    "size-cap:grew",
    "size-cap:stale",
    "debt-marker",
    "duplicate-file",
    "missing-fileoverview",
    "orphan-gen-dir",
    "doc-ref:dangling",
    "doc-hub:missing",
  ]);
  const danglingCount = dirtyDiags.filter((d) => d.rule === "doc-ref:dangling").length;
  if (danglingCount < 4) {
    console.error(`self-test FAIL — expected ≥4 doc-ref:dangling, got ${danglingCount}`);
    rmSync(base, { recursive: true, force: true });
    process.exit(1);
  }
  const missing = [...want].filter((w) => !got.has(w));
  if (missing.length > 0) {
    console.error(`self-test FAIL — dirty tree did not fire: ${missing.join(", ")}`);
    console.error(`  got: ${[...got].sort().join(", ")}`);
    rmSync(base, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Clean tree: zero diagnostics required ──────────────────────────────
  const clean = join(base, "clean");
  const cleanCfg = makeConfig({
    "packages/a/src/big-ok.ts": { lines: 420, rationale: "clean big fixture" },
  });
  writeFixture(join(clean, "maintainability.json"), cleanCfg);
  writeFixture(join(clean, "packages/a/src/ok.ts"), "export const ok = 1;\n");
  writeFixture(
    join(clean, "packages/a/src/big-ok.ts"),
    "/** @fileoverview clean big fixture. */\n".concat(pad(417, "export const bigOk = 1;\n")),
  );
  writeFixture(join(clean, "docs/decisions/001-x.md"), "- Verification: `packages/a/src/ok.ts`\n");
  writeFixture(join(clean, ".agents/skills/z/SKILL.md"), "- Uses: `packages/a/src/ok.ts`\n");
  writeFixture(
    join(clean, "docs/ai/ok.md"),
    "- Uses: `packages/a/src/ok.ts`\ncovers `packages/*/test` and `docs/*.md`\npath `packages/a/src/\nok.ts`\n",
  );
  // The clean hub lists every clean doc — the doc-hub rule must stay quiet.
  writeFixture(
    join(clean, "docs/README.md"),
    "# hub\n\n| Path | Topic |\n| --- | --- |\n| `docs/ai/ok.md` | ok |\n",
  );

  const cleanDiags = runRules(clean);
  if (cleanDiags.length > 0) {
    console.error("self-test FAIL — clean tree produced diagnostics:");
    for (const d of cleanDiags) console.error(`  ${d.path}: ${d.rule}`);
    rmSync(base, { recursive: true, force: true });
    process.exit(1);
  }

  rmSync(base, { recursive: true, force: true });
  console.log(
    "check:maintainability self-test: PASS (all 9 rules fire on fixtures; clean tree is clean)",
  );
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const rootIdx = args.indexOf("--root");
  const root = (rootIdx >= 0 ? args[rootIdx + 1] : undefined) ?? process.cwd();
  if (!existsSync(join(root, "maintainability.json"))) {
    console.error(`check:maintainability: no maintainability.json at ${root}`);
    process.exit(1);
  }
  if (args.includes("--report")) {
    report(root);
    return;
  }

  const diags = runRules(root);
  if (diags.length > 0) {
    console.error(`check:maintainability FAILED — ${diags.length} violation(s):`);
    for (const d of diags)
      console.error(`  ${d.path}: ${d.rule}${d.detail ? ` (${d.detail})` : ""}`);
    process.exit(1);
  }
  const n = collectSrcFiles(root, loadConfig(root)).length;
  console.log(`check:maintainability: OK — ${n} src files, no violations`);
};

main();
