/**
 * Verify the npm tarball contents before publishing (`bun run pack:check`).
 *
 * Runs `bun pm pack --dry-run --ignore-scripts` and parses its "packed …"
 * listing, then asserts:
 *   - every file consumers need is present (source entrypoints, rust source, docs)
 *   - nothing heavy/private leaks in (rust/target, dist, node_modules, client-dist)
 *
 * Warnings (not failures):
 *   - no prebuilds staged — source-only tarballs are valid; the release flow
 *     stages the addon via `prepack`/`prebuild` at publish time.
 *
 * Exits non-zero on any problem so it can gate `release` and CI.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const REQUIRED = [
  "index.ts",
  "public/server.ts",
  "public/client.ts",
  "public/nats.ts",
  "public/events.ts",
  "public/bindings.ts",
  "public/generate.ts",
  "public/internal.ts",
  "docs/events.md",
  "src/schema/index.ts",
  "src/core/server.ts",
  "src/core/client.ts",
  "src/native/loader.ts",
  // codegen (consumed at runtime by `ignex-nova/generate`)
  "src/codegen/schema-model.ts",
  "src/codegen/typebox-to-fbs.ts",
  "src/codegen/registry-gen.ts",
  "src/codegen/ts-ser-gen.ts",
  "src/codegen/direct-gen.ts",
  "src/codegen/rust-glue-gen.ts",
  "src/codegen/fingerprint.ts",
  "rust/Cargo.toml",
  "rust/src/lib.rs",
  "docs/wire-format.md",
  "README.md",
  "LICENSE",
  "package.json",
];

const FORBIDDEN_PREFIXES = [
  "rust/target/",
  "dist/",
  "client-dist/",
  "node_modules/",
  "bench/",
  "client/",
  "test/",
  "scripts/",
];

const PACKED_LINE = /^packed\s+\S+\s+(.+)$/gm;

function die(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function packList(): string[] {
  let raw: string;
  try {
    raw = execSync("bun pm pack --dry-run --ignore-scripts", {
      cwd: root,
      encoding: "utf8",
    });
  } catch (err) {
    die(`pack dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const paths: string[] = [];
  for (const match of raw.matchAll(PACKED_LINE)) {
    const path = match[1]?.trim();
    if (path !== undefined && path !== "") {
      paths.push(path);
    }
  }
  if (paths.length === 0) {
    die("could not parse `bun pm pack --dry-run` output (no `packed …` lines).");
  }
  return paths;
}

const paths = packList();

console.log(`\n📦 Tarball contains ${paths.length} files\n`);

const missing = REQUIRED.filter((p) => !paths.includes(p));
if (missing.length > 0) {
  die(`required files missing from the tarball:\n  ${missing.join("\n  ")}`);
}

const leaks = paths.filter((p) => FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)));
if (leaks.length > 0) {
  die(`unexpected files in the tarball (should be excluded):\n  ${leaks.join("\n  ")}`);
}

const prebuilds = paths.filter((p) => p.startsWith("prebuilds/"));
if (prebuilds.length === 0) {
  console.warn(
    "⚠  no prebuilds/ staged — source-only tarball (rebuild or set IGNEX_FFI_PATH in consumers).",
  );
} else {
  console.log("✔ staged prebuilds:");
  for (const p of prebuilds) {
    console.log(`  ${p}`);
  }
}

console.log(`\n✔ All ${REQUIRED.length} required files present, no forbidden paths.`);
