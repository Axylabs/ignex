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
 *   6. decision-refs — paths cited in `docs/decisions/*.md` `Verification:`
 *                    lines must exist (doc-rot guard).
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

/** Rule 6 — every `Verification:` path cited by a decision file must exist. */
const checkDecisionRefs = (root: string, diags: Diag[]): void => {
  const decisionsDir = join(root, "docs", "decisions");
  if (!existsSync(decisionsDir)) return;
  for (const f of readdirSync(decisionsDir).filter((f) => f.endsWith(".md"))) {
    const src = readFileSync(join(decisionsDir, f), "utf8");
    for (const line of src.split("\n")) {
      const body = line.trim().replace(/^-\s+/, "");
      if (!body.startsWith("Verification:")) continue;
      for (const m of body.matchAll(/`([^`]+)`/g)) {
        const token = m[1];
        if (!token) continue;
        if (!/^(?:packages|scripts|docs|RULES)\//.test(token) && token !== "RULES.md") continue;
        if (!existsSync(join(root, token))) {
          diags.push({
            path: `docs/decisions/${f}`,
            rule: "decision-ref:dangling",
            detail: `Verification cites missing path \`${token}\``,
          });
        }
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
 * Rules 6/3 run at the tree level; 1/2/5 per file; 4 across all files.
 */
const runRules = (root: string): Diag[] => {
  const cfg = loadConfig(root);
  const diags: Diag[] = [];
  const rel = (p: string): string => posix(p.slice(root.length + 1));

  checkDecisionRefs(root, diags);
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
    "decision-ref:dangling",
  ]);
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

  const cleanDiags = runRules(clean);
  if (cleanDiags.length > 0) {
    console.error("self-test FAIL — clean tree produced diagnostics:");
    for (const d of cleanDiags) console.error(`  ${d.path}: ${d.rule}`);
    rmSync(base, { recursive: true, force: true });
    process.exit(1);
  }

  rmSync(base, { recursive: true, force: true });
  console.log(
    "check:maintainability self-test: PASS (all 8 rules fire on fixtures; clean tree is clean)",
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
