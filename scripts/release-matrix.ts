/**
 * @fileoverview Release matrix — the versions a given checkout actually carries.
 *
 * `packages/*` version independently (a release bumps only the changed packages
 * plus their dependents), so one train legitimately spans several versions and
 * there is no single "ignex version" to pin. This prints that set
 * deterministically instead of hard-coding version literals into the docs —
 * `RULES.md` §6 and `check:consistency` forbid repeating versions in prose.
 *
 * Usage:
 *   bun scripts/release-matrix.ts           # Markdown table for humans
 *   bun scripts/release-matrix.ts --json    # machine-readable, for tooling
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The subset of a workspace manifest this report needs. */
interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
}

/** One row of the report. */
interface Row {
  /** Package name as published (e.g. `@ignex/core`). */
  name: string;
  /** Repo-relative directory of the manifest. */
  dir: string;
  /** Current version declared by the manifest. */
  version: string;
  /** False when the manifest is `private` (never published). */
  published: boolean;
}

const ROOT = join(import.meta.dir, "..");

/** Read every `packages/<dir>/package.json`, sorted by package name. */
function readRows(): Row[] {
  const rows: Row[] = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/${entry.name}`;
    const raw = readFileSync(join(ROOT, dir, "package.json"), "utf8");
    const manifest = JSON.parse(raw) as Manifest;
    rows.push({
      name: manifest.name ?? dir,
      dir,
      version: manifest.version ?? "0.0.0",
      published: manifest.private !== true,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct versions across publishable packages, lowest → highest. */
const distinctVersions = (rows: readonly Row[]): string[] =>
  [...new Set(rows.filter((r) => r.published).map((r) => r.version))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

const rows = readRows();
const versions = distinctVersions(rows);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ packages: rows, publishedVersions: versions }, null, 2));
} else {
  console.log("| Package | Version | Published |");
  console.log("| --- | --- | --- |");
  for (const row of rows) {
    const state = row.published ? "yes" : "no (private)";
    console.log(`| \`${row.name}\` | ${row.version} | ${state} |`);
  }
  console.log(
    `\n${rows.length} package(s); ${versions.length} distinct published version(s): ${versions.join(", ")}\n` +
      "Consumers pin semver ranges, not a single version — see docs/release-process.md.",
  );
}
