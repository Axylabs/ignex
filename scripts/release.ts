/**
 * @fileoverview Canonical release/publish flow for the ignex product family.
 *
 * Every product repo (ignex, castrum, ninox, nova) ships an identical copy of
 * this script. It reads a small `.release.json` at the repo root that captures
 * only the product-specific differences (workspace vs single package, verify /
 * pack commands, version files to sync, and the npm publish strategy). The CLI
 * surface, step ordering and output are identical across every repo.
 *
 * Canonical pipeline (each phase skippable via flags):
 *
 *   1. preflight — clean git tree (+ npm auth when publishing locally)
 *   2. version   — bump root/workspace package.json(s) + configured version
 *                  files (Cargo.toml/lock, CHANGELOG, …)
 *   3. verify    — `verify` commands from config (post-bump gate)
 *   4. pack      — `checks` commands from config (tarball/content guards)
 *   5. publish   — local npm publish when the strategy is `local` (or when
 *                  `--publish` is passed for a `ci`-strategy product)
 *   6. git       — commit + tag v<version> (+ push with `--push`)
 *
 * `ci`-strategy products (castrum) skip local publish by default: pushing the
 * `v*` tag is what triggers the CI multi-platform publish.
 *
 * Usage (from repo root):
 *   bun run release                     # patch bump + full flow
 *   bun run release minor               # minor bump
 *   bun run release major               # major bump
 *   bun run release --version 0.2.0     # explicit version
 *   bun run release:dry                 # print the plan, change nothing
 *   bun run release --no-verify         # skip the verify gate
 *   bun run release --no-pack           # skip the pack/content checks
 *   bun run release --no-commit         # bump + publish, no git commit/tag
 *   bun run release --no-tag            # commit but do not tag
 *   bun run release --no-bump           # reuse current version (retry)
 *   bun run release --no-publish        # bump + git only (never local publish)
 *   bun run release --publish           # force a local publish (ci-strategy)
 *   bun run release --packages shared   # workspace: bump subset + dependents
 *   bun run release --push              # also push branch + tags
 *   bun run release --yes               # skip the confirmation prompt
 *   bun run release --allow-dirty       # skip the clean-tree check
 *   bun run release --no-preflight      # skip clean-tree + npm-auth checks
 *   bun run release --tag beta          # publish under the `beta` dist-tag
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

// The script lives at <repo-root>/scripts/release.ts.
const ROOT = join(import.meta.dir, "..");
const CONFIG_FILE = join(ROOT, ".release.json");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUMP_KINDS = ["patch", "minor", "major"] as const;
type BumpKind = (typeof BUMP_KINDS)[number];

const DEP_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** A file whose version string must track the released version. */
type VersionFile =
  | { type: "npm"; file: string }
  | { type: "regex"; file: string; pattern: string; sub: string }
  | { type: "changelog"; file: string; unreleased: string };

interface ReleaseConfig {
  product: string;
  type: "workspace" | "single";
  packageDir?: string;
  dependencyScope?: string;
  lockfile?: "bun";
  verify: string[];
  checks?: string[];
  postBump?: string[];
  versionFiles?: VersionFile[];
  publish: {
    strategy: "local" | "ci";
    manager?: "bun" | "npm";
    /** Single-package template; {version} {distTag} {access} {otp} are filled. */
    command?: string;
  };
}

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
  isPrivate: boolean;
  productDeps: string[];
}

interface CliArgs {
  bump: BumpKind;
  explicitVersion: string | null;
  dryRun: boolean;
  verify: boolean;
  pack: boolean;
  commit: boolean;
  tag: boolean;
  push: boolean;
  bumpVersions: boolean;
  publish: boolean;
  noPublish: boolean;
  yes: boolean;
  allowDirty: boolean;
  preflight: boolean;
  distTag: string;
  access: string;
  otp: string | null;
  packageFilter: string[] | null;
}

/* ------------------------------------------------------------------ */

function die(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
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

/** Run a shell command streaming to the terminal; abort on non-zero exit. */
function run(command: string, label: string): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, { cwd: ROOT, shell: "/bin/sh", stdio: "inherit" });
  if (result.status !== 0) {
    die(`command failed (exit ${result.status ?? "?"}): ${command}`);
  }
}

/** Run an argv array (no shell) streaming to the terminal; abort on failure. */
function runRaw(args: string[], label: string): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(args[0] ?? "", args.slice(1), { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    die(`command failed (exit ${result.status ?? "?"}): ${args.join(" ")}`);
  }
}

/** Run an argv array and return its exit code without aborting. */
function exitCode(args: string[], cwd?: string): number {
  const result = spawnSync(args[0] ?? "", args.slice(1), {
    cwd: cwd ?? ROOT,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function capture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
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

const VALUE_FLAGS = new Set(["bump", "version", "tag", "access", "otp", "packages"]);

function parseCli(argv: string[]): CliArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
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
    pack: !has("no-pack"),
    commit: !has("no-commit"),
    tag: !has("no-tag"),
    push: has("push"),
    bumpVersions: !has("no-bump"),
    publish: has("publish"),
    noPublish: has("no-publish"),
    yes: has("yes"),
    allowDirty: has("allow-dirty"),
    preflight: !has("no-preflight"),
    distTag: value("tag") ?? "latest",
    access: value("access") ?? "public",
    otp: value("otp"),
    packageFilter:
      value("packages")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? null,
  };
}

function loadConfig(): ReleaseConfig {
  if (!existsSync(CONFIG_FILE)) {
    die(`missing ${CONFIG_FILE} — every product repo must ship one.`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as ReleaseConfig;
  if (raw.product === undefined || raw.type === undefined || raw.verify === undefined) {
    die(`${CONFIG_FILE} is missing required fields (product, type, verify).`);
  }
  if (raw.type === "workspace" && raw.packageDir === undefined) {
    die(`${CONFIG_FILE}: workspace releases need "packageDir".`);
  }
  return raw;
}

function bumpVersion(version: string, bump: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) {
    die(`cannot parse current version "${version}"`);
  }
  const [, major, minor, patch, pre] = match;
  const parts: [number, number, number] = [Number(major), Number(minor), Number(patch)];
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

/* ------------------------------------------------------------------ */

/** Apply a `regex` version file (used by Cargo.toml/Cargo.lock syncs). */
function applyRegexVersionFile(
  file: string,
  vf: Extract<VersionFile, { type: "regex" }>,
  version: string,
): string {
  const original = readFileSync(file, "utf8");
  const next = original.replace(
    new RegExp(vf.pattern, "m"),
    vf.sub.replace("__VERSION__", version),
  );
  if (next === original) {
    die(`version pattern did not match in ${vf.file} — nothing was updated.`);
  }
  writeFileSync(file, next);
  console.log(`  synced ${vf.file} → ${version}`);
  return original;
}

/** Finalize a Keep-a-Changelog `Unreleased` section into a dated release. */
function applyChangelogFile(file: string, marker: string, version: string): string {
  const original = readFileSync(file, "utf8");
  if (!original.includes(marker)) {
    console.warn(`  ⚠  ${file} has no "${marker}" section — changelog not updated.`);
    return original;
  }
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(file, original.replace(marker, `${marker}\n\n## [${version}] — ${date}`));
  console.log(`  finalized ${file} → ## [${version}] — ${date}`);
  return original;
}

/**
 * Apply npm/regex/changelog version files. Returns the original contents of
 * every file it touched, keyed by absolute path, so a failed publish can roll
 * the release back.
 */
function syncVersionFiles(versionFiles: VersionFile[], version: string): Map<string, string> {
  const backups = new Map<string, string>();
  for (const vf of versionFiles) {
    const file = join(ROOT, vf.file);
    if (!existsSync(file)) {
      die(`version file missing: ${vf.file}`);
    }
    if (vf.type === "npm") {
      const manifest = readJson(file);
      if (manifest.version !== undefined) {
        backups.set(file, readFileSync(file, "utf8"));
        writeJson(file, { ...manifest, version });
        console.log(`  synced ${vf.file} → ${version}`);
      }
    } else if (vf.type === "regex") {
      backups.set(file, applyRegexVersionFile(file, vf, version));
    } else {
      backups.set(file, applyChangelogFile(file, vf.unreleased, version));
    }
  }
  return backups;
}

/** Restore every backed-up file (used when a publish fails mid-release). */
function restoreBackups(backups: Map<string, string>): void {
  for (const [file, content] of backups) {
    writeFileSync(file, content);
  }
}

/* ------------------------------------------------------------------ */
/* Workspace helpers                                                     */
/* ------------------------------------------------------------------ */

function discoverPackages(packageDir: string, scope: string): PkgInfo[] {
  const packages: PkgInfo[] = [];
  for (const entry of readdirSync(join(ROOT, packageDir), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(ROOT, packageDir, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = readJson(manifestPath);
    if (manifest.name === undefined || manifest.version === undefined) {
      continue;
    }
    const productDeps = DEP_SECTIONS.flatMap((section) =>
      Object.keys(manifest[section] ?? {}),
    ).filter((name) => name.startsWith(scope));
    packages.push({
      name: manifest.name,
      dir,
      relDir: `${packageDir}/${entry.name}`,
      isPrivate: manifest.private === true,
      productDeps: [...new Set(productDeps)],
    });
  }
  return packages;
}

/** Dependency-first publish order; deterministic tie-break by name. */
function publishOrder(packages: PkgInfo[]): PkgInfo[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const indegree = new Map(
    packages.map((pkg) => [pkg.name, pkg.productDeps.filter((dep) => byName.has(dep)).length]),
  );
  const queue = packages.filter((pkg) => indegree.get(pkg.name) === 0).map((pkg) => pkg.name);
  const ordered: string[] = [];

  while (queue.length > 0) {
    queue.sort();
    const name = queue.shift() as string;
    ordered.push(name);
    for (const other of packages) {
      if (!other.productDeps.includes(name)) {
        continue;
      }
      const next = (indegree.get(other.name) ?? 1) - 1;
      indegree.set(other.name, next);
      if (next === 0) {
        queue.push(other.name);
      }
    }
  }

  const remaining = packages
    .filter((pkg) => !ordered.includes(pkg.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...ordered.map((name) => byName.get(name) as PkgInfo), ...remaining];
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

/** Expand to every package that transitively depends on the selection. */
function expandDependents(selected: PkgInfo[], allPackages: PkgInfo[]): PkgInfo[] {
  const dependents = new Map<string, string[]>();
  for (const pkg of allPackages) {
    for (const dep of pkg.productDeps) {
      const list = dependents.get(dep) ?? [];
      list.push(pkg.name);
      dependents.set(dep, list);
    }
  }
  const included = new Set(selected.map((pkg) => pkg.name));
  const queue = [...included];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    for (const parent of dependents.get(name) ?? []) {
      if (!included.has(parent)) {
        included.add(parent);
        queue.push(parent);
      }
    }
  }
  return allPackages.filter((pkg) => included.has(pkg.name));
}

/**
 * bun records each workspace package's version in bun.lock and won't refresh it
 * on a plain `bun install` after a bump — a stale entry makes `bun publish`
 * rewrite `workspace:*` deps to the old version, producing broken tarballs.
 */
function verifyBunLockVersions(nextVersion: string, targetNames: Set<string>): void {
  const lockfile = join(ROOT, "bun.lock");
  if (!existsSync(lockfile)) {
    die("bun.lock is missing — run `bun install` before releasing.");
  }
  const text = readFileSync(lockfile, "utf8").replace(/,([\s]*[}\]])/g, "$1");
  let lock: { workspaces?: Record<string, { name?: string; version?: string }> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    die("could not parse bun.lock — run `bun install` to regenerate it.");
  }
  const stale: string[] = [];
  for (const meta of Object.values(lock.workspaces ?? {})) {
    if (typeof meta?.name !== "string" || !targetNames.has(meta.name)) {
      continue;
    }
    if (meta.version !== nextVersion) {
      stale.push(`${meta.name}@${meta.version}`);
    }
  }
  if (stale.length > 0) {
    die(
      `bun.lock records stale workspace versions (${stale.join(", ")}) — expected these packages at ${nextVersion}.\n` +
        "  Fix: delete bun.lock, run `bun install`, then re-run.",
    );
  }
  console.log(`✔ bun.lock workspace versions verified at v${nextVersion}.`);
}

/* ------------------------------------------------------------------ */
/* Preflight + publish                                                  */
/* ------------------------------------------------------------------ */

function preflight(args: CliArgs, publishingLocally: boolean): void {
  if (capture("git", ["status", "--porcelain"]) !== "") {
    if (args.allowDirty) {
      console.warn("⚠  working tree has uncommitted changes (--allow-dirty).");
    } else {
      die("working tree is not clean — commit or stash changes, or pass --allow-dirty.");
    }
  }
  if (publishingLocally) {
    const whoami = spawnSync("npm", ["whoami"], { cwd: ROOT, encoding: "utf8" });
    const account = whoami.status === 0 ? whoami.stdout.trim() : "";
    if (account === "") {
      console.warn(
        "⚠  could not verify npm auth (npm CLI unavailable or not logged in) — publish may fail.",
      );
    } else {
      console.log(`🔐 npm auth: ${account} (verified via npm whoami)`);
    }
  }
}

function renderCommand(template: string, args: CliArgs, version: string): string {
  return template
    .replaceAll("{version}", version)
    .replaceAll("{distTag}", args.distTag)
    .replaceAll("{access}", args.access)
    .replaceAll("{otp}", args.otp ?? "");
}

async function publishSingle(
  cfg: ReleaseConfig,
  args: CliArgs,
  nextVersion: string,
  backups: Map<string, string>,
): Promise<void> {
  const fallback =
    cfg.publish.manager === "bun"
      ? "bun publish --access {access} --tag {distTag}"
      : "npm publish --access {access} --tag {distTag}";
  const command = renderCommand(cfg.publish.command ?? fallback, args, nextVersion);
  const ready = args.yes || (await confirm(`Publish to npm as v${nextVersion}?`));
  if (!ready) {
    console.log("✋ publish declined — nothing was changed.");
    return;
  }
  console.log(`\n🚀 Publishing as v${nextVersion} …`);
  const result = spawnSync(command, { cwd: ROOT, shell: "/bin/sh", stdio: "inherit" });
  if (result.status !== 0) {
    restoreBackups(backups);
    die(
      "publish failed — version files rolled back. " +
        "Rerun with --no-bump --no-verify --no-pack once the issue is fixed.",
    );
  }
  console.log("✔ published.");
}

async function publishWorkspace(
  args: CliArgs,
  order: PkgInfo[],
  nextVersion: string,
  backups: Map<string, string>,
): Promise<void> {
  if (order.length === 0) {
    die("no publishable packages");
  }
  const ready =
    args.yes || (await confirm(`Publish ${order.length} package(s) to npm as v${nextVersion}?`));
  if (!ready) {
    console.log(
      "✋ publish declined — versions are bumped. Rerun with --no-bump to commit/tag only.",
    );
    return;
  }
  for (const pkg of order) {
    const publishArgs = [
      "bun",
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
    if (exitCode(publishArgs, pkg.dir) !== 0) {
      restoreBackups(backups);
      die(
        `publish failed after ${pkg.name} — already-published packages remain on npm.\n` +
          "  Version files rolled back. Rerun with --no-bump --no-verify --no-pack to finish publishing.",
      );
    }
  }
}

/* ------------------------------------------------------------------ */

function gitFinalize(args: CliArgs, cfg: ReleaseConfig, nextVersion: string): void {
  if (!args.commit) {
    return;
  }
  console.log(`\n🔖 Committing + tagging v${nextVersion} …`);
  runRaw(["git", "add", "-A"], "git add");
  runRaw(["git", "commit", "-m", `release(${cfg.product}): v${nextVersion}`], "git commit");
  if (args.tag) {
    runRaw(["git", "tag", `v${nextVersion}`], "git tag");
  }
  if (args.push) {
    runRaw(["git", "push"], "git push");
    if (args.tag) {
      runRaw(["git", "push", "--tags"], "git push --tags");
    }
  }
}

function versionBumpLabel(args: CliArgs): string {
  if (!args.bumpVersions) {
    return "(reuse current)";
  }
  if (args.explicitVersion !== null) {
    return "(explicit)";
  }
  return `(${args.bump})`;
}

function publishModeLabel(args: CliArgs, cfg: ReleaseConfig): string {
  if (args.noPublish) {
    return "none";
  }
  if (cfg.publish.strategy === "local" || args.publish) {
    return "local npm";
  }
  return "CI (tag push)";
}

function printPlan(args: CliArgs, cfg: ReleaseConfig, current: string, next: string): void {
  const gitLabel = `${args.commit ? "commit" : "skip"}${args.tag ? " + tag" : ""}${args.push ? " + push" : ""}`;
  printBox([
    `${cfg.product} release`,
    `  version  ${current} → ${next} ${versionBumpLabel(args)}`,
    `  publish  ${publishModeLabel(args, cfg)}`,
    `  git      ${gitLabel}`,
  ]);
}

/* ------------------------------------------------------------------ */

interface ReleaseContext {
  currentVersion: string;
  nextVersion: string;
  selected: PkgInfo[] | null;
  publishingLocally: boolean;
}

function resolveContext(
  args: CliArgs,
  cfg: ReleaseConfig,
  rootManifest: PackageJson,
): ReleaseContext {
  const currentVersion = rootManifest.version ?? "0.0.0";
  const nextVersion = resolveNextVersion(args, currentVersion);
  const workspace =
    cfg.type === "workspace"
      ? discoverPackages(cfg.packageDir ?? "packages", cfg.dependencyScope ?? "")
      : null;
  const selected =
    workspace === null ? null : expandDependents(selectTargets(args, workspace), workspace);
  const publishingLocally = args.noPublish
    ? false
    : args.publish || cfg.publish.strategy === "local";
  return { currentVersion, nextVersion, selected, publishingLocally };
}

function syncWorkspaceVersions(
  selected: PkgInfo[],
  nextVersion: string,
  backups: Map<string, string>,
): void {
  for (const pkg of selected) {
    const manifestPath = join(pkg.dir, "package.json");
    const manifest = readJson(manifestPath);
    backups.set(manifestPath, readFileSync(manifestPath, "utf8"));
    writeJson(manifestPath, { ...manifest, version: nextVersion });
    console.log(`  synced ${pkg.relDir}/package.json → ${nextVersion}`);
  }
}

function bumpVersions(
  args: CliArgs,
  cfg: ReleaseConfig,
  currentVersion: string,
  nextVersion: string,
  selected: PkgInfo[] | null,
  backups: Map<string, string>,
): void {
  if (!args.bumpVersions) {
    return;
  }
  console.log(`\n✏️  Bumping version ${currentVersion} → ${nextVersion} …`);
  const versionFiles: VersionFile[] = [
    { type: "npm", file: "package.json" },
    ...(cfg.versionFiles ?? []),
  ];
  for (const [file, content] of syncVersionFiles(versionFiles, nextVersion)) {
    backups.set(file, content);
  }
  if (selected === null) {
    return;
  }
  syncWorkspaceVersions(selected, nextVersion, backups);
  for (const cmd of cfg.postBump ?? []) {
    run(cmd, cmd);
  }
  if (cfg.lockfile === "bun") {
    verifyBunLockVersions(nextVersion, new Set(selected.map((pkg) => pkg.name)));
  }
}

function runGates(args: CliArgs, cfg: ReleaseConfig): void {
  if (args.verify) {
    console.log("\n🔍 Running verify gate …");
    for (const cmd of cfg.verify) {
      run(cmd, cmd);
    }
  }
  if (args.pack && (cfg.checks ?? []).length > 0) {
    console.log("\n📦 Running pack/content checks …");
    for (const cmd of cfg.checks ?? []) {
      run(cmd, cmd);
    }
  }
}

async function doPublish(
  args: CliArgs,
  cfg: ReleaseConfig,
  selected: PkgInfo[] | null,
  nextVersion: string,
  backups: Map<string, string>,
): Promise<void> {
  if (selected === null) {
    await publishSingle(cfg, args, nextVersion, backups);
    return;
  }
  await publishWorkspace(
    args,
    publishOrder(selected.filter((pkg) => !pkg.isPrivate)),
    nextVersion,
    backups,
  );
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const cfg = loadConfig();
  const context = resolveContext(args, cfg, readJson(join(ROOT, "package.json")));

  printPlan(args, cfg, context.currentVersion, context.nextVersion);
  if (args.dryRun) {
    console.log("✔ dry-run — nothing was changed.");
    return;
  }
  if (args.preflight) {
    preflight(args, context.publishingLocally);
  }

  const backups = new Map<string, string>();
  bumpVersions(args, cfg, context.currentVersion, context.nextVersion, context.selected, backups);
  runGates(args, cfg);

  if (context.publishingLocally) {
    await doPublish(args, cfg, context.selected, context.nextVersion, backups);
  }

  gitFinalize(args, cfg, context.nextVersion);

  console.log("\n✔ Release complete.");
  if (args.noPublish) {
    console.log("  (local publish skipped — --no-publish)");
  }
}

void main();
