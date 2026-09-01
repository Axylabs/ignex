/**
 * @fileoverview JSDoc completeness checker for the ignex public API.
 *
 * Walks the export graph of every scoped package's `exports` entry points
 * (`packages/{core,shared,compiler,cli,mcp,native}/src/*.ts`) and flags any
 * public symbol (function, class, type, const, enum) that is exported without
 * an attached JSDoc comment block directly above its declaration.
 *
 * Because packages ship source-only (`exports` point at `src/*.ts`), the JSDoc
 * in `src/` IS the consumer-facing API documentation — this script is the gate
 * that keeps it complete and prevents regressions.
 *
 * Usage:
 *   bun scripts/check-jsdoc.ts              # report mode (exit 0)
 *   bun scripts/check-jsdoc.ts --strict     # CI gate (exit 1 if any missing)
 *   bun scripts/check-jsdoc.ts --packages core,shared
 *   bun scripts/check-jsdoc.ts --json       # machine-readable report
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as oxcParser from "oxc-parser";

const SCOPED_PACKAGES = ["core", "shared", "compiler", "cli", "mcp", "native"] as const;

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const SRC_SUBDIR = "src";

/* ------------------------------------------------------------------ *
 * CLI arg parsing (minimal, matches scripts/ conventions).           *
 * ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const jsonOut = args.includes("--json");
const packagesArg = args.find((a) => a.startsWith("--packages="));
const onlyPackages = packagesArg
  ? packagesArg.slice("--packages=".length).split(",").filter(Boolean)
  : undefined;

/* ------------------------------------------------------------------ *
 * Module resolution (relative + workspace `@ignex/*` only).          *
 * ------------------------------------------------------------------ */

interface PkgJson {
  main?: string;
  types?: string;
  exports?: string | Record<string, string | Record<string, string>>;
}

function isInScope(file: string): boolean {
  return SCOPED_PACKAGES.some((p) => file.startsWith(`${join(PACKAGES_DIR, p, SRC_SUBDIR)}/`));
}

function pkgOf(file: string): string | null {
  for (const p of SCOPED_PACKAGES) {
    if (file.startsWith(`${join(PACKAGES_DIR, p, SRC_SUBDIR)}/`)) return p;
  }
  return null;
}

function readPkgJson(pkg: string): PkgJson {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, pkg, "package.json"), "utf8")) as PkgJson;
}

/** Pick the first `.ts`-shaped target out of an exports entry value. */
function exportTargetValue(target: string | Record<string, string>): string | null {
  if (typeof target === "string") return target.endsWith(".ts") ? target : null;
  for (const key of ["types", "import", "default", "require"] as const) {
    const v = target[key];
    if (v?.endsWith(".ts")) return v;
  }
  return null;
}

/** Resolve an exports-map subpath to an absolute file inside the package. */
function resolveSubpath(pkg: string, subpath: string): string | null {
  const pkgJson = readPkgJson(pkg);
  const exportsField = pkgJson.exports;
  if (typeof exportsField === "string") {
    const target = exportsField.endsWith(".ts") ? exportsField : null;
    return target ? resolveFile(join(PACKAGES_DIR, pkg, target.slice(2))) : null;
  }
  if (exportsField && typeof exportsField === "object") {
    const target = exportsField[subpath];
    if (target) {
      const value = exportTargetValue(target);
      if (value)
        return resolveFile(
          join(PACKAGES_DIR, pkg, value.startsWith("./") ? value.slice(2) : value),
        );
    }
  }
  // Fall back to main/types.
  const fallback = pkgJson.main ?? pkgJson.types;
  if (fallback?.endsWith(".ts")) return resolveFile(join(PACKAGES_DIR, pkg, fallback));
  return null;
}

/** Resolve a module specifier to an absolute file, or null for out-of-scope. */
function resolveModule(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) {
    return resolveFile(resolve(dirname(fromFile), spec));
  }
  if (spec.startsWith("@ignex/")) {
    const rest = spec.slice("@ignex/".length);
    const slash = rest.indexOf("/");
    const pkg = slash === -1 ? rest : rest.slice(0, slash);
    const sub = slash === -1 ? "." : `./${rest.slice(slash + 1)}`;
    if (!(SCOPED_PACKAGES as readonly string[]).includes(pkg)) return null;
    return resolveSubpath(pkg, sub);
  }
  return null; // external / builtin
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveFile(base: string): string | null {
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.d.ts"),
  ]) {
    if (isFile(cand)) return cand;
  }
  return null;
}

/** Entry-point files for a package (from its `exports` map). */
function packageEntries(pkg: string): string[] {
  const pkgJson = readPkgJson(pkg);
  const exportsField = pkgJson.exports;
  const files: string[] = [];
  if (typeof exportsField === "string") {
    if (exportsField.endsWith(".ts")) files.push(join(PACKAGES_DIR, pkg, exportsField.slice(2)));
  } else if (exportsField && typeof exportsField === "object") {
    for (const [subpath, target] of Object.entries(exportsField)) {
      if (subpath.endsWith(".json")) continue;
      const value = exportTargetValue(target);
      if (value)
        files.push(join(PACKAGES_DIR, pkg, value.startsWith("./") ? value.slice(2) : value));
    }
  } else {
    const fallback = pkgJson.main ?? pkgJson.types;
    if (fallback?.endsWith(".ts")) files.push(join(PACKAGES_DIR, pkg, fallback));
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * Export-graph traversal.                                             *
 * ------------------------------------------------------------------ */

interface CommentLike {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
}

interface PublicSymbol {
  pkg: string;
  file: string;
  name: string;
  start: number;
  isType: boolean;
  source: string;
  comments: CommentLike[];
}

interface DeclInfo {
  start: number;
  isType: boolean;
}

/** Map of local binding name → declaration info for top-level declarations. */
function buildDeclarationMap(program: { body: unknown[] }): Map<string, DeclInfo> {
  const map = new Map<string, DeclInfo>();

  const record = (name: string | undefined, start: number | undefined, isType: boolean): void => {
    if (name && start !== undefined) map.set(name, { start, isType });
  };

  const walkNode = (node: Record<string, any> | null | undefined, startOverride?: number): void => {
    if (node == null || typeof node !== "object") return;
    // For `export function/class/interface …` the inner declaration's span
    // starts AFTER the `export` keyword; use the export wrapper's offset so
    // the JSDoc directly above `export` is treated as attached.
    const start = (startOverride ?? node.span?.start ?? node.start) as number | undefined;
    if (start === undefined) return;
    const type = node.type as string;

    if (type === "VariableDeclaration") {
      for (const decl of (node.declarations ?? []) as Record<string, any>[]) {
        const id = decl?.id as Record<string, any> | undefined;
        if (id?.type === "Identifier") record(id.name, start, false);
      }
      return;
    }

    if (type === "FunctionDeclaration" || type === "ClassDeclaration") {
      record((node.id as { name?: string } | undefined)?.name, start, false);
      return;
    }

    if (type === "TSInterfaceDeclaration" || type === "TSTypeAliasDeclaration") {
      record((node.id as { name?: string } | undefined)?.name, start, true);
      return;
    }

    if (type === "TSEnumDeclaration" || type === "TSModuleDeclaration") {
      record((node.id as { name?: string } | undefined)?.name, start, false);
    }
  };

  for (const stmt of program.body) {
    const s = stmt as Record<string, any>;
    const declaration = s.declaration as Record<string, any> | undefined;
    // Export wrappers carry the declaration; the wrapper's own start is the `export` keyword.
    walkNode(declaration ?? s, declaration ? (s.span?.start ?? s.start) : undefined);
  }
  return map;
}

/**
 * Statement start offsets whose export carries a direct declaration
 * (`export function/const/class/interface …`), as opposed to a specifier-list
 * re-export (`export { x }`). For those, the export statement itself is the
 * declaration, so the JSDoc sits directly above it.
 */
function directExportStarts(program: { body: unknown[] }): Set<number> {
  const starts = new Set<number>();
  for (const stmt of program.body) {
    const s = stmt as Record<string, any>;
    const type = s.type as string;
    const start = (s.span?.start ?? s.start) as number | undefined;
    if (start === undefined) continue;
    if (type === "ExportDefaultDeclaration") {
      starts.add(start);
    } else if (type === "ExportNamedDeclaration" && s.declaration != null) {
      starts.add(start);
    }
  }
  return starts;
}

/** Map of local imported binding name → module specifier. */
function buildImportMap(module: { staticImports: unknown[] }): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of module.staticImports as Record<string, any>[]) {
    const spec = imp.source?.value as string | undefined;
    if (!spec) continue;
    const names: Array<string | null | undefined> = [];
    if (imp.imported) {
      // `import { a as b, type C } from "x"`
      for (const specifier of imp.imported as Record<string, any>[]) {
        names.push(specifier.imported?.name ?? specifier.local?.name);
      }
    }
    if (imp.namespaceName) names.push(imp.namespaceName.name);
    if (imp.defaultName) names.push(imp.defaultName.name);
    for (const name of names) {
      if (name) map.set(name, spec);
    }
  }
  return map;
}

interface CollectedSymbols {
  symbols: Map<string, PublicSymbol>;
  files: Set<string>;
}

function collectPackage(pkg: string, out: CollectedSymbols): void {
  for (const entry of packageEntries(pkg)) {
    collectModule(entry, out);
  }
}

function collectModule(file: string, out: CollectedSymbols): void {
  if (!isInScope(file) || out.files.has(file)) return;
  out.files.add(file);

  const source = readFileSync(file, "utf8");
  const result = oxcParser.parseSync(file, source, {
    sourceType: "module",
    lang: file.endsWith(".d.ts") ? "dts" : "ts",
  });

  if (result.errors.length > 0) {
    console.error(`  warn: failed to parse ${file}: ${result.errors[0]?.message ?? "parse error"}`);
  }

  const declMap = buildDeclarationMap(result.program);
  const importMap = buildImportMap(result.module);
  const directStarts = directExportStarts(result.program);
  const comments = result.comments as CommentLike[];
  const pkg = pkgOf(file) ?? "?";

  const record = (entry: Record<string, any>, name: string, start: number) => {
    const key = `${file}\u0000${name}`;
    if (out.symbols.has(key)) return;
    out.symbols.set(key, {
      pkg,
      file,
      name,
      start,
      isType: entry.isType as boolean,
      source,
      comments,
    });
  };

  const collectDirect = (entry: Record<string, any>, exp: Record<string, any>) => {
    const publicName: string | null = entry.exportName?.name ?? null;
    const localName: string | null = entry.localName?.name ?? null;
    const name = publicName ?? "default";
    let start: number = exp.start as number;

    // A specifier-only export (`export { x }`): the JSDoc lives on the
    // original declaration, not on the re-export statement.
    if (localName && !directStarts.has(exp.start as number)) {
      const decl = declMap.get(localName);
      if (decl) {
        start = decl.start;
      } else {
        const importedFrom = importMap.get(localName);
        if (!importedFrom) return record(entry, name, start);
        // `import { x } from "./y"; export { x };` — docs live in the target.
        const target = resolveModule(importedFrom, file);
        if (target) collectModule(target, out);
        return;
      }
    }

    record(entry, name, start);
  };

  for (const exp of result.module.staticExports as Record<string, any>[]) {
    for (const entry of exp.entries as Record<string, any>[]) {
      const moduleRequest: string | null = entry.moduleRequest?.value ?? null;
      if (moduleRequest) {
        // Re-export from another module (specific or `export *`): walk the target.
        const target = resolveModule(moduleRequest, file);
        if (target) collectModule(target, out);
        continue;
      }
      collectDirect(entry, exp);
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSDoc attachment check.                                             *
 * ------------------------------------------------------------------ */

function hasJsdoc(sym: PublicSymbol): boolean {
  let nearest: CommentLike | null = null;
  for (const c of sym.comments) {
    if (c.type !== "Block" || c.end > sym.start) continue;
    if (!nearest || c.end > nearest.end) nearest = c;
  }
  if (!nearest) return false;
  if (!nearest.value.startsWith("*")) return false; // plain `/* */`, not JSDoc
  // Allow only whitespace (and `//` line comments) between the block and the declaration.
  const gap = sym.source.slice(nearest.end, sym.start).replace(/\/\/[^\n]*/g, "");
  return /^\s*$/.test(gap);
}

function lineOf(sym: PublicSymbol): number {
  return sym.source.slice(0, sym.start).split("\n").length;
}

/* ------------------------------------------------------------------ *
 * Report.                                                             *
 * ------------------------------------------------------------------ */

function run(): number {
  const out: CollectedSymbols = { symbols: new Map(), files: new Set() };
  const targets = onlyPackages
    ? SCOPED_PACKAGES.filter((p) => onlyPackages?.includes(p))
    : [...SCOPED_PACKAGES];

  for (const pkg of targets) collectPackage(pkg, out);

  const symbols = [...out.symbols.values()];
  const missing = symbols
    .filter((s) => !hasJsdoc(s))
    .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);

  const byPkg = new Map<string, { total: number; missing: number }>();
  for (const s of symbols) {
    const rec = byPkg.get(s.pkg) ?? { total: 0, missing: 0 };
    rec.total += 1;
    if (!hasJsdoc(s)) rec.missing += 1;
    byPkg.set(s.pkg, rec);
  }

  const covered = symbols.length - missing.length;
  const pct = symbols.length === 0 ? 100 : Math.round((covered / symbols.length) * 100);

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          packages: Object.fromEntries(byPkg),
          total: symbols.length,
          documented: covered,
          missing: missing.length,
          coveragePct: pct,
          strict,
          missingSymbols: missing.map((s) => ({
            pkg: s.pkg,
            file: s.file.replace(`${ROOT}/`, ""),
            line: lineOf(s),
            name: s.name,
            kind: s.isType ? "type" : "value",
          })),
        },
        null,
        2,
      ),
    );
    return strict && missing.length > 0 ? 1 : 0;
  }

  console.log(
    `\nJSDoc completeness (${symbols.length} public symbols across ${targets.join(", ")}):`,
  );
  for (const [pkg, rec] of [...byPkg.entries()].sort()) {
    const p = rec.total === 0 ? 100 : Math.round(((rec.total - rec.missing) / rec.total) * 100);
    console.log(
      `  ${pkg.padEnd(9)} ${String(rec.total - rec.missing).padStart(4)}/${String(rec.total).padEnd(4)} documented  (${p}%)`,
    );
  }
  console.log(`  overall: ${covered}/${symbols.length} documented (${pct}%)`);

  if (missing.length > 0) {
    console.log(`\n${missing.length} public symbol(s) missing JSDoc:`);
    for (const s of missing) {
      const rel = s.file.replace(`${ROOT}/`, "");
      console.log(`  ${rel}:${lineOf(s)}  ${s.name}${s.isType ? "  [type]" : ""}`);
    }
    if (strict) {
      console.error("\nFAIL: run `bun run jsdoc:check` to list all missing symbols.");
      return 1;
    }
    console.log("\n(not failing — pass --strict to treat missing JSDoc as an error)");
  } else {
    console.log("\nAll public symbols have JSDoc. \u2713");
  }
  return 0;
}

process.exit(run());
