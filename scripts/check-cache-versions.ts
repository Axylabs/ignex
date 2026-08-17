/**
 * Release pre-flight: verify compiler cache versions are bumped when generated
 * output changes.
 *
 * The compiler cache is keyed on `COMPILER_CACHE_VERSION` (whole-build) and
 * `MODULES_CACHE_VERSION` (parse cache). A change to codegen / native-loader
 * source alters the GENERATED SERVER OUTPUT but does NOT change the cache
 * fingerprint (which hashes routes + options + core/src — not the compiler's
 * own codegen source) — so without a version bump, a consumer with a stale
 * cache silently runs the previous build. This checks that any
 * output-affecting change since the last release tag is accompanied by a
 * cache-version bump.
 *
 * Usage: `bun scripts/check-cache-versions.ts` (run by scripts/publish.ts before
 * bump/commit; also useful standalone in CI / pre-push).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** Paths whose changes alter generated output / cache behavior. */
const OUTPUT_AFFECTING = [
  "packages/native/src/loader.ts",
  "packages/native/src/ffi.ts",
  "packages/native/src/runtime.ts",
  "packages/native/src/selection.ts",
  "packages/compiler/src/phases/codegen",
  "packages/compiler/src/phases/artifacts",
  "packages/compiler/src/frontend/persist.ts",
  "packages/compiler/src/cache.ts",
];

/** The version constants that must be bumped when OUTPUT_AFFECTING changes. */
const CACHE_MARKERS = [
  { file: "packages/compiler/src/cache.ts", name: "COMPILER_CACHE_VERSION" },
  { file: "packages/compiler/src/frontend/persist.ts", name: "MODULES_CACHE_VERSION" },
] as const;

const readMarker = (file: string, name: string): string | undefined => {
  if (!existsSync(file)) return undefined;
  const src = readFileSync(file, "utf-8");
  const re = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`);
  return re.exec(src)?.[1];
};

const markerAtTag = (tag: string, file: string, name: string): string | undefined => {
  try {
    const src = execFileSync("git", ["show", `${tag}:${file}`], { encoding: "utf-8" });
    const re = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`);
    return re.exec(src)?.[1];
  } catch {
    return undefined; // file did not exist at the tag
  }
};

const changedSinceTag = (tag: string, paths: string[]): boolean => {
  try {
    const out = execFileSync("git", ["diff", "--name-only", tag, "--", ...paths], {
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo / tag missing — be conservative and treat as changed.
    return true;
  }
};

const lastTag = (): string | undefined => {
  try {
    return execFileSync("git", ["describe", "--abbrev=0", "--tags"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
};

const main = (): void => {
  const tag = lastTag();
  if (!tag) {
    console.log("check-cache-versions: no previous git tag — skipping.");
    process.exit(0);
  }
  if (!changedSinceTag(tag, OUTPUT_AFFECTING)) {
    console.log(`check-cache-versions: no output-affecting changes since ${tag}.`);
    process.exit(0);
  }

  const problems: string[] = [];
  for (const { file, name } of CACHE_MARKERS) {
    const before = markerAtTag(tag, file, name);
    const after = readMarker(file, name);
    if (before !== undefined && before === after) {
      problems.push(
        `${name} (${file}) is still "${before}" but an output-affecting file changed since ${tag}.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("check-cache-versions FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nGenerated output changed but the cache version did not — stale caches would serve " +
        "the previous build. Bump the constant(s) in the same change (or pass " +
        "--no-cache-check to override).",
    );
    process.exit(1);
  }

  console.log(
    `check-cache-versions: cache version(s) bumped with output-affecting changes since ${tag}.`,
  );
};

main();
