/**
 * @fileoverview Consistency gate — catches the documentation drift the other
 * gates cannot see (the class of bug that let `RULES.md`/`AGENTS.md` claim
 * `0.1.32` while the workspace was on `0.2.x`, and let docs cite scripts and
 * files that had been deleted).
 *
 * Enforces:
 *   1. script-refs   — every `bun run <name>` and `bun scripts/<file>.ts`
 *                      cited in the agent-facing docs must exist (in the root
 *                      `package.json` `scripts`, or on disk).
 *   2. path-refs     — every backticked `docs/…`, `.agents/…` or `scripts/…`
 *                      path cited in those docs must exist (the doc-rot guard,
 *                      widened beyond `docs/decisions` + skills + `docs/ai`).
 *   3. supported-version — `SECURITY.md`'s `<major>.<minor>.x` supported row
 *                      must match the root `package.json` version.
 *   4. no-prose-version — `RULES.md`/`AGENTS.md` must not repeat a literal
 *                      `X.Y.Z` version: the root `package.json` is the single
 *                      source of truth and `scripts/release.ts` rewrites the
 *                      tracked version files (`.release.json` `versionFiles`).
 *   5. exports-surface — the published `exports` subpath map of every
 *                      workspace package is a public contract: a removed or
 *                      added subpath must be a deliberate baseline update
 *                      (`scripts/api-surface.json`), and every target must
 *                      exist on disk.
 *
 * Usage:
 *   bun scripts/check-consistency.ts              # gate (exit 1 on violation)
 *   bun scripts/check-consistency.ts --update     # refresh the api-surface baseline
 *   bun scripts/check-consistency.ts --self-test  # fixture suite for the parsers
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Root-level agent-facing docs that must stay consistent with the code. */
const ROOT_DOCS = ["AGENTS.md", "RULES.md", "CONTRIBUTING.md", "README.md", "SECURITY.md"] as const;

/**
 * Script names cited in the docs that belong to a SIBLING repo's tooling
 * (`ninox`/`nova`/`castrum`), not to this workspace.
 */
const CROSS_REPO_SCRIPTS = new Set(["prepublishOnly", "check:api", "build:rust"]);

/**
 * Script names that exist in a SCAFFOLDED app (`ignex create`), not in this
 * workspace — source of truth `packages/cli/src/templates/project.ts`.
 */
const USER_APP_SCRIPTS = new Set([
  "dev",
  "build",
  "start",
  "route",
  "lint",
  "format",
  "typecheck",
  "test",
]);

/**
 * Paths cited in the docs that live in a sibling repo (`docs/…` is the path
 * *inside* `castrum`). Kept explicit so a real deletion still fails the gate.
 */
const CROSS_REPO_PATHS = new Set([
  "docs/bun-builtins-decision-matrix.md",
  "docs/FFI_BUN_GUIDE.md",
  "scripts/verify-native-batch.ts",
]);

const rel = (p: string): string => p.slice(ROOT.length + 1).replace(/\\/g, "/");

/** Every doc the gate scans: root docs, `docs/**\/*.md`, and the skills. */
const collectDocs = (): string[] => {
  const out: string[] = ROOT_DOCS.map((f) => join(ROOT, f));
  const walk = (dir: string, filter: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
        walk(p, filter);
      } else if (entry.isFile() && filter(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(join(ROOT, "docs"), (n) => n.endsWith(".md"));
  walk(join(ROOT, ".agents"), (n) => n === "SKILL.md");
  return out;
};

/** Bare `X.Y.Z` literals, excluding dependency ranges (`^0.9.10`/`~1.2.3`/`v1.2.3`). */
const findBareSemver = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/\d+\.\d+\.\d+/g)) {
    const prev = m.index > 0 ? text[m.index - 1] : "";
    if (prev === "^" || prev === "~" || prev === "v" || prev === "=") continue;
    out.push(m[0]);
  }
  return out;
};

/** Parse the `<major>.<minor>.x` supported row out of `SECURITY.md`. */
const supportedMinor = (text: string): string | null =>
  text.match(/\|\s*(\d+\.\d+)\.x\s*\|/)?.[1] ?? null;

/** Where the committed public-API contract lives. */
const BASELINE = "scripts/api-surface.json";

interface WorkspacePackage {
  dir: string;
  name: string;
  exports: Record<string, unknown>;
}

/** Published (non-private) workspace packages that declare an `exports` map. */
const readPackages = (): WorkspacePackage[] => {
  const out: WorkspacePackage[] = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ROOT, "packages", entry.name);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, unknown>;
    };
    if (!manifest.name || manifest.private || !manifest.exports) continue;
    out.push({ dir, name: manifest.name, exports: manifest.exports });
  }
  return out;
};

/** `{ "@ignex/core": [".", "./http", …] }` — sorted for a stable diff. */
const collectSurface = (): Record<string, string[]> => {
  const surface: Record<string, string[]> = {};
  for (const pkg of readPackages()) {
    surface[pkg.name] = Object.keys(pkg.exports).sort();
  }
  return surface;
};

/**
 * Serialize the surface the way Biome formats JSON — an array stays inline when
 * the whole line fits the 100-column print width, and expands otherwise. This
 * keeps `--update` output lint-clean without hand-editing the baseline.
 */
const serializeSurface = (surface: Record<string, string[]>): string => {
  const lines = Object.keys(surface)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const subs = surface[name] ?? [];
      const key = JSON.stringify(name);
      const inline = `[${subs.map((s) => JSON.stringify(s)).join(", ")}]`;
      const value =
        2 + key.length + 2 + inline.length <= 100
          ? inline
          : JSON.stringify(subs, null, 2).replace(/\n/g, "\n  ");
      return `  ${key}: ${value}`;
    });
  return `{\n${lines.join(",\n")}\n}\n`;
};

/** Rule 5 — the published `exports` subpath map is a public contract. */
const checkSurface = (update: boolean, diags: string[]): void => {
  const current = collectSurface();
  const file = join(ROOT, BASELINE);
  if (update) {
    writeFileSync(file, serializeSurface(current));
    console.log(`\u2714 api-surface baseline updated (${Object.keys(current).length} packages)`);
    return;
  }
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Record<string, string[]>;
  for (const [name, subpaths] of Object.entries(current)) {
    const before = baseline[name];
    if (!before) {
      diags.push(
        `${BASELINE}: \`${name}\` is untracked — run \`bun scripts/check-consistency.ts --update\``,
      );
      continue;
    }
    for (const s of before.filter((x) => !subpaths.includes(x))) {
      diags.push(`${name}: public subpath \`${s}\` removed — that is a breaking change`);
    }
    for (const s of subpaths.filter((x) => !before.includes(x))) {
      diags.push(`${name}: public subpath \`${s}\` added — refresh \`${BASELINE}\` deliberately`);
    }
  }
  for (const name of Object.keys(baseline)) {
    if (!current[name]) diags.push(`${name}: published package is gone from the workspace`);
  }
  // Every export target must resolve on disk (a typo'd subpath is a 404 at install).
  for (const pkg of readPackages()) {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target !== "string") continue;
      if (target.includes("*")) continue; // wildcard subpath map (`./bin/*`)
      if (!existsSync(join(pkg.dir, target))) {
        diags.push(`${pkg.name}: export \`${subpath}\` → \`${target}\` does not exist`);
      }
    }
  }
};

const selfTest = (): void => {
  const fail = (m: string): never => {
    console.error(`\u2716 self-test: ${m}`);
    process.exit(1);
  };
  // findBareSemver: bare literals flagged, ranges/prefixes skipped.
  if (findBareSemver("are `0.1.32`").join() !== "0.1.32") fail("bare literal missed");
  if (findBareSemver("`^0.9.10`").length !== 0) fail("dependency range flagged");
  if (findBareSemver("v0.2.0 tag").length !== 0) fail("tag prefix flagged");
  // supportedMinor.
  if (supportedMinor("| 0.2.x | \u2705 |") !== "0.2") fail("supported row missed");
  if (supportedMinor("no table here") !== null) fail("absent row should be null");
  console.log("\u2714 check-consistency self-test passed");
};

/** Rules 1–2 — the script and path citations inside one doc file. */
const checkDoc = (file: string, scripts: Set<string>, diags: string[]): void => {
  const relPath = rel(file);
  const text = readFileSync(file, "utf8");

  for (const m of text.matchAll(/bun run\s+([a-zA-Z][\w:-]*)/g)) {
    const name = m[1] ?? "";
    const after = text[m.index + m[0].length] ?? "";
    if (after === "*") continue; // `bun run bench:*` — a family, not one script
    if (scripts.has(name) || USER_APP_SCRIPTS.has(name) || CROSS_REPO_SCRIPTS.has(name)) {
      continue;
    }
    diags.push(`${relPath}: cites unknown script \`bun run ${name}\``);
  }
  for (const m of text.matchAll(/bun\s+(scripts\/[\w./-]+\.ts)/g)) {
    const path = m[1] ?? "";
    if (!existsSync(join(ROOT, path))) {
      diags.push(`${relPath}: cites missing script \`${path}\``);
    }
  }
  // Paths: the `docs/`, `.agents/`, `scripts/` subset (low false positives).
  for (const m of text.matchAll(/`((?:docs|\.agents|scripts)\/[^`]+)`/g)) {
    const token = m[1] ?? "";
    if (!token || /\s/.test(token)) continue; // a command line, not a path
    if (/[*?]/.test(token)) continue; // glob, not a path
    if (CROSS_REPO_PATHS.has(token)) continue;
    if (!existsSync(join(ROOT, token))) {
      diags.push(`${relPath}: cites missing path \`${token}\``);
    }
  }
};

/** Rules 3–4 — the version litmus tests. */
const checkVersions = (rootVersion: string, diags: string[]): void => {
  const rootMinor = rootVersion.split(".").slice(0, 2).join(".");
  const secMinor = supportedMinor(readFileSync(join(ROOT, "SECURITY.md"), "utf8"));
  if (secMinor !== rootMinor) {
    diags.push(
      `SECURITY.md: supported version is \`${secMinor ?? "<none>"}.x\` but the workspace is on \`${rootMinor}.x\``,
    );
  }
  for (const name of ["RULES.md", "AGENTS.md"]) {
    for (const v of findBareSemver(readFileSync(join(ROOT, name), "utf8"))) {
      diags.push(`${name}: hard-codes version \`${v}\` — point at package.json instead`);
    }
  }
};

const main = (): void => {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const diags: string[] = [];
  if (process.argv.includes("--update")) {
    checkSurface(true, diags);
    return;
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
    scripts: Record<string, string>;
  };
  const scripts = new Set(Object.keys(pkg.scripts));
  const docs = collectDocs();
  for (const file of docs) {
    checkDoc(file, scripts, diags);
  }
  checkVersions(pkg.version, diags);
  checkSurface(false, diags);

  if (diags.length > 0) {
    console.error(`\u2716 consistency: ${diags.length} problem(s)`);
    for (const d of diags) console.error(`  - ${d}`);
    process.exit(1);
  }
  console.log(`\u2714 consistency: ${docs.length} docs, ${scripts.size} scripts — no drift`);
};

main();
