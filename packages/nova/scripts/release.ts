/**
 * Single-package release/publish script for ignex-nova.
 *
 * One command: bump the version, run the verify + pack gates, publish the
 * package to npm from source (`bun publish` → runs `prepublishOnly` (generate
 * + verify) and `prepack` (stages the native addon into prebuilds/)), then
 * commit + tag + push.
 *
 * Usage (from repo root):
 *   bun run release                 # patch bump + full flow
 *   bun run release minor           # minor bump
 *   bun run release major           # major bump
 *   bun run release --version 0.2.0 # explicit version
 *   bun run release:dry             # print the plan, change nothing
 *   bun run release --no-verify     # skip the verify gate
 *   bun run release --no-publish    # bump + commit + tag only
 *   bun run release --no-bump       # reuse the current version (retry)
 *   bun run release --no-commit     # bump + publish, no git tag/commit
 *   bun run release --no-check      # skip the tarball contents check
 *   bun run release --yes           # skip the confirmation prompt
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const ROOT = join(import.meta.dir, "..");
const MANIFEST = join(ROOT, "package.json");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUMP_KINDS = ["patch", "minor", "major"] as const;
type BumpKind = (typeof BUMP_KINDS)[number];

interface Manifest {
  name: string;
  version: string;
}
interface CliArgs {
  bump: BumpKind;
  explicitVersion: string | null;
  dryRun: boolean;
  verify: boolean;
  publish: boolean;
  commit: boolean;
  tag: boolean;
  push: boolean;
  bumpVersions: boolean;
  yes: boolean;
  distTag: string;
  access: string;
  otp: string | null;
  check: boolean;
}

/* ------------------------------------------------------------------ */

function die(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(cmd: string, args: string[], options: { cwd?: string; check?: boolean } = {}): number {
  const result = spawnSync(cmd, args, { cwd: options.cwd ?? ROOT, stdio: "inherit" });
  if (options.check && result.status !== 0) {
    die(`command failed: ${cmd} ${args.join(" ")} (exit ${result.status})`);
  }
  return result.status ?? 1;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
}
function writeManifest(manifest: Manifest): void {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function printBox(lines: string[]): void {
  const inner = Math.max(...lines.map((line) => line.length)) + 2;
  const bar = "─".repeat(inner);
  console.log(`\n┌${bar}┐`);
  for (const line of lines) {
    console.log(`│ ${line.padEnd(inner - 1)}│`);
  }
  console.log(`└${bar}┘\n`);
}

function parseCli(argv: string[]): CliArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const VALUE_FLAGS = new Set(["version", "tag", "access", "otp"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
      continue;
    }
    flags.set(name, true);
  }
  const value = (name: string): string | null => {
    const found = flags.get(name);
    return typeof found === "string" ? found : null;
  };
  const has = (name: string): boolean => flags.has(name);

  const bumpRaw = positionals[0] ?? value("bump") ?? "patch";
  if (!BUMP_KINDS.includes(bumpRaw as BumpKind)) {
    die(`invalid bump kind "${bumpRaw}" (expected ${BUMP_KINDS.join(" | ")})`);
  }
  const explicitVersion = value("version");
  if (explicitVersion !== null && !SEMVER.test(explicitVersion)) {
    die(`invalid --version "${explicitVersion}" (expected semver like 0.2.0)`);
  }

  return {
    bump: bumpRaw as BumpKind,
    explicitVersion,
    dryRun: has("dry-run"),
    verify: !has("no-verify"),
    publish: !has("no-publish"),
    commit: !has("no-commit"),
    tag: !has("no-tag"),
    push: has("push"),
    bumpVersions: !has("no-bump"),
    yes: has("yes"),
    distTag: value("tag") ?? "latest",
    access: value("access") ?? "public",
    otp: value("otp"),
    check: !has("no-check"),
  };
}

function bumpVersion(version: string, bump: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) {
    die(`cannot parse current version "${version}"`);
  }
  const [, major, minor, patch, pre] = match;
  const parts: [number, number, number] = [Number(major), Number(minor), Number(patch)];
  if (pre !== undefined) {
    return parts.join("."); // a prerelease finalizes on any bump: 0.2.0-beta.1 → 0.2.0
  }
  if (bump === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (bump === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[2] += 1;
  }
  return parts.join(".");
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/* ------------------------------------------------------------------ */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: release wizard is inherently branchy
async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const manifest = readManifest();
  const currentVersion = manifest.version ?? "0.0.0";
  const nextVersion =
    args.explicitVersion ??
    (args.bumpVersions ? bumpVersion(currentVersion, args.bump) : currentVersion);

  printBox([
    "ignex-nova release",
    `  version  ${currentVersion} → ${nextVersion}${args.bumpVersions ? ` (${args.bump})` : " (reuse)"}`,
    `  publish  ${args.publish ? "bun publish" : "(skipped)"}`,
    `  git      ${args.commit ? "commit" : "(skipped)"}${args.tag ? " + tag" : ""}${args.push ? " + push" : ""}`,
  ]);

  if (args.dryRun) {
    console.log("✔ dry-run — nothing was changed.");
    return;
  }

  if (args.bumpVersions) {
    if (nextVersion === currentVersion) {
      die(`version is already ${currentVersion} — nothing to bump.`);
    }
    console.log(`✏️  Bumping version ${currentVersion} → ${nextVersion} …`);
    writeManifest({ ...manifest, version: nextVersion });
  }

  if (args.verify) {
    console.log("\n🧪 Running verify gate (typecheck + lint + test) …");
    run("bun", ["run", "verify"], { check: true });
  }

  if (args.check) {
    console.log("\n📦 Checking npm tarball contents …");
    run("bun", ["run", "pack:check"], { check: true });
  }

  if (args.publish) {
    const ready = args.yes || (await confirm(`Publish ${manifest.name}@${nextVersion} to npm?`));
    if (!ready) {
      console.log(
        "✋ publish declined — version is bumped. Rerun with --no-bump --no-verify --no-commit to publish.",
      );
      return;
    }
    const publishArgs = ["publish", "--tag", args.distTag, "--access", args.access];
    if (args.otp !== null) {
      publishArgs.push("--otp", args.otp);
    }
    console.log(`\n🚀 Publishing ${manifest.name}@${nextVersion} …`);
    run("bun", publishArgs, { check: true });
  }

  if (args.commit) {
    console.log(`\n🔖 Committing + tagging v${nextVersion} …`);
    run("git", ["add", "-A"], { check: true });
    run("git", ["commit", "-m", `release(ignex-nova): v${nextVersion}`], { check: true });
    if (args.tag) {
      run("git", ["tag", `v${nextVersion}`], { check: true });
    }
    if (args.push) {
      run("git", ["push"], { check: true });
      if (args.tag) {
        run("git", ["push", "--tags"], { check: true });
      }
    }
  }

  console.log("\n✔ Release complete.");
}

void main();
