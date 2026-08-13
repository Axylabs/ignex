/**
 * @fileoverview Manual release/publish script for the Ignex monorepo.
 *
 * One-command flow: bump the shared version across the workspace, run the
 * verify gate, commit + tag, then publish every scoped package to npm in
 * dependency order.
 *
 * Dependency ranges are intentionally left as `workspace:*` in source — `bun
 * publish` resolves them to the real sibling version at pack time, so the repo
 * keeps using workspace links during local development.
 *
 * Usage (from repo root):
 *   bun scripts/publish.ts                 # patch bump + full release flow
 *   bun scripts/publish.ts minor           # minor bump
 *   bun scripts/publish.ts major           # major bump
 *   bun scripts/publish.ts --version 0.2.0 # explicit version
 *   bun scripts/publish.ts --dry-run       # print the plan, change nothing
 *   bun scripts/publish.ts --no-verify     # skip `bun run verify`
 *   bun scripts/publish.ts --no-publish    # bump + commit + tag only
 *   bun scripts/publish.ts --no-commit     # bump + publish, no git commit/tag
 *   bun scripts/publish.ts --no-bump       # reuse current versions (retry)
 *   bun scripts/publish.ts --yes           # skip the confirmation prompt
 *   bun scripts/publish.ts --packages core,shared
 *   bun scripts/publish.ts --no-check      # skip the npm auth/scope pre-flight
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const ROOT_MANIFEST = join(ROOT, "package.json");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUMP_KINDS = ["patch", "minor", "major"] as const;
type BumpKind = (typeof BUMP_KINDS)[number];

const DEP_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PkgInfo {
  name: string;
  dir: string;
  relDir: string;
  version: string;
  isPrivate: boolean;
  ignexDeps: string[];
}

interface CliArgs {
  bump: BumpKind;
  explicitVersion: string | null;
  dryRun: boolean;
  verify: boolean;
  publish: boolean;
  commit: boolean;
  tag: boolean;
  bumpVersions: boolean;
  push: boolean;
  yes: boolean;
  distTag: string;
  access: string;
  otp: string | null;
  packageFilter: string[] | null;
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

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

function writeJson(file: string, data: PackageJson): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
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

/* ------------------------------------------------------------------ */

const VALUE_FLAGS = new Set(["bump", "version", "packages", "tag", "access", "otp"]);

function parseCli(argv: string[]): CliArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    bumpVersions: !has("no-bump"),
    push: has("push"),
    yes: has("yes"),
    distTag: value("tag") ?? "latest",
    access: value("access") ?? "public",
    otp: value("otp"),
    packageFilter:
      value("packages")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? null,
    check: !has("no-check"),
  };
}

function discoverPackages(): PkgInfo[] {
  const packages: PkgInfo[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(PACKAGES_DIR, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = readJson(manifestPath);
    if (manifest.name === undefined || manifest.version === undefined) {
      continue;
    }
    const ignexDeps = DEP_SECTIONS.flatMap((section) =>
      Object.keys(manifest[section] ?? {}),
    ).filter((name) => name.startsWith("@ignex/"));
    packages.push({
      name: manifest.name,
      dir,
      relDir: `packages/${entry.name}`,
      version: manifest.version,
      isPrivate: manifest.private === true,
      ignexDeps: [...new Set(ignexDeps)],
    });
  }
  return packages;
}

/**
 * Dependency-first order so each package is published only after every
 * `@ignex/*` package it references. A deterministic tie-break (alphabetical)
 * resolves the `@ignex/cli` ↔ `@ignex/mcp` cycle the same way the docs do.
 */
function publishOrder(packages: PkgInfo[]): PkgInfo[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const indegree = new Map(
    packages.map((pkg) => [pkg.name, pkg.ignexDeps.filter((dep) => byName.has(dep)).length]),
  );
  const queue = packages.filter((pkg) => indegree.get(pkg.name) === 0).map((pkg) => pkg.name);
  const ordered: string[] = [];

  while (queue.length > 0) {
    queue.sort();
    const name = queue.shift() as string;
    ordered.push(name);
    for (const other of packages) {
      if (!other.ignexDeps.includes(name)) {
        continue;
      }
      const next = (indegree.get(other.name) ?? 1) - 1;
      indegree.set(other.name, next);
      if (next === 0) {
        queue.push(other.name);
      }
    }
  }

  const cycle = packages
    .filter((pkg) => !ordered.includes(pkg.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...ordered.map((name) => byName.get(name) as PkgInfo), ...cycle];
}

function bumpVersion(version: string, bump: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) {
    die(`cannot parse current version "${version}"`);
  }
  const [, major, minor, patch, pre] = match;
  const parts = [Number(major), Number(minor), Number(patch)];
  if (pre !== undefined) {
    // A prerelease finalizes on any bump: 0.2.0-beta.1 → 0.2.0.
    return parts.join(".");
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

function resolveNextVersion(args: CliArgs, currentVersion: string): string {
  if (!args.bumpVersions) {
    return currentVersion;
  }
  const next = args.explicitVersion ?? bumpVersion(currentVersion, args.bump);
  if (args.explicitVersion === null && next === currentVersion) {
    die(`version is already ${currentVersion} — nothing to bump`);
  }
  return next;
}

function selectTargets(args: CliArgs, allPackages: PkgInfo[]): PkgInfo[] {
  const filter = args.packageFilter;
  if (filter === null) {
    return allPackages;
  }
  const allowed = new Set(filter);
  return allPackages.filter((pkg) => {
    const shortName = pkg.name.slice(pkg.name.lastIndexOf("/") + 1);
    return allowed.has(pkg.name) || allowed.has(shortName);
  });
}

function printPlan(
  args: CliArgs,
  currentVersion: string,
  nextVersion: string,
  targets: PkgInfo[],
  order: PkgInfo[],
): void {
  const bumpLabel = !args.bumpVersions
    ? "(reuse current)"
    : args.explicitVersion !== null
      ? "(explicit)"
      : `(${args.bump})`;
  const publishNames = order.map((pkg) => pkg.name).join(" → ") || "(none)";
  const privateNames =
    targets
      .filter((pkg) => pkg.isPrivate)
      .map((pkg) => pkg.name)
      .join(", ") || "(none)";
  printBox([
    "Ignex release",
    `  version   ${currentVersion} → ${nextVersion} ${bumpLabel}`,
    `  publish   ${publishNames}`,
    `  private   ${privateNames}`,
  ]);
}

function warnIfDirty(args: CliArgs): void {
  if (args.commit && run("git", ["diff", "--quiet"], { check: false }) !== 0) {
    console.warn("⚠  working tree has uncommitted changes — the release commit will include them.");
  }
}

function getNpmAccount(): string | null {
  const result = spawnSync("npm", ["whoami"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    return null;
  }
  const account = result.stdout.trim();
  return account === "" ? null : account;
}

/**
 * Fail-fast check that runs before any version bump or commit: confirms the
 * configured npm token can actually publish to the package scope. npm returns
 * 403 from `npm org ls <scope>` when the account is not a member of that org,
 * and the registry answers 404 on the publish PUT — the exact failure you'd
 * otherwise hit halfway through the release.
 */
function checkPublishAccess(order: PkgInfo[]): void {
  const first = order[0];
  if (first === undefined) {
    return;
  }
  const slash = first.name.indexOf("/");
  const scope = slash === -1 ? null : first.name.slice(1, slash);
  const account = getNpmAccount();
  if (account === null) {
    console.warn(
      "⚠  could not verify npm auth (npm CLI unavailable or not logged in) — continuing without a publish pre-flight.",
    );
    return;
  }
  console.log(`\n🔐 npm auth: ${account} (verified via npm whoami)`);
  if (scope === null) {
    return; // unscoped packages don't require an org
  }
  const org = spawnSync("npm", ["org", "ls", scope], { cwd: ROOT, encoding: "utf8" });
  if (org.status !== 0) {
    die(
      `account "${account}" cannot publish to @${scope}/* — it is not a member of the "${scope}" npm org (or the org does not exist).\n` +
        `  Fix once: create the "${scope}" org at https://www.npmjs.com/org/create and add "${account}" as an Owner, then re-run.`,
    );
  }
}

function bumpAllVersions(targets: PkgInfo[], rootManifest: PackageJson, nextVersion: string): void {
  console.log(`✏️  Bumping ${targets.length} package(s) + root to v${nextVersion} …`);
  for (const pkg of targets) {
    const manifest = readJson(join(pkg.dir, "package.json"));
    manifest.version = nextVersion;
    writeJson(join(pkg.dir, "package.json"), manifest);
  }
  rootManifest.version = nextVersion;
  writeJson(ROOT_MANIFEST, rootManifest);
  if (run("bun", ["install"], { check: false }) !== 0) {
    console.warn("⚠  `bun install` failed — verify the lockfile before committing.");
  }
}

function gitCommitAndTag(args: CliArgs, nextVersion: string): void {
  run("git", ["add", "-A"], { check: true });
  run("git", ["commit", "-m", `release(ignex): v${nextVersion}`], { check: true });
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

async function runPublish(args: CliArgs, order: PkgInfo[], nextVersion: string): Promise<void> {
  if (order.length === 0) {
    die("no publishable packages");
  }
  const ready =
    args.yes || (await confirm(`Publish ${order.length} package(s) to npm as v${nextVersion}?`));
  if (!ready) {
    console.log(
      "✋ publish declined — versions are bumped & committed. Rerun with --no-bump --no-verify --no-commit to publish.",
    );
    return;
  }
  for (const pkg of order) {
    const publishArgs = [
      "publish",
      "--cwd",
      pkg.dir,
      "--access",
      args.access,
      "--tag",
      args.distTag,
    ];
    if (args.otp !== null) {
      publishArgs.push("--otp", args.otp);
    }
    console.log(`\n🚀 Publishing ${pkg.name}@${nextVersion} (${pkg.relDir}) …`);
    run("bun", publishArgs, { check: true });
  }
}

function printSummary(args: CliArgs, published: number, nextVersion: string): void {
  console.log("\n✔ Release complete.");
  if (args.publish) {
    console.log(`  Published ${published} package(s) as v${nextVersion}.`);
    console.log("  Reminder: git push && git push --tags (unless --push was used).");
  } else {
    console.log(
      `  Versions bumped to v${nextVersion}. Run again without --no-publish to push to npm.`,
    );
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const rootManifest = readJson(ROOT_MANIFEST);
  const currentVersion = rootManifest.version ?? "0.0.0";
  const nextVersion = resolveNextVersion(args, currentVersion);

  const targets = selectTargets(args, discoverPackages());
  const order = publishOrder(targets.filter((pkg) => !pkg.isPrivate));
  printPlan(args, currentVersion, nextVersion, targets, order);

  if (args.dryRun) {
    const bumpAction = args.bumpVersions ? "bumped" : "released";
    console.log(
      `✔ dry-run — ${targets.length} package(s) would be ${bumpAction}, ${order.length} published. No changes made.`,
    );
    return;
  }

  if (args.publish && args.check) {
    checkPublishAccess(order);
  }

  if (args.bumpVersions) {
    bumpAllVersions(targets, rootManifest, nextVersion);
  }
  warnIfDirty(args);

  if (args.verify) {
    console.log("\n🔍 Running verify gate …");
    run("bun", ["run", "verify"], { check: true });
  }

  if (args.commit) {
    gitCommitAndTag(args, nextVersion);
  }

  if (args.publish) {
    await runPublish(args, order, nextVersion);
  }

  printSummary(args, order.length, nextVersion);
}

await main();
