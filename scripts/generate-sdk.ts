#!/usr/bin/env bun
/**
 * Standalone SDK generator + distributor for the ignex example app (and any
 * app with the same layout: `packages/app` with `bun run build` emitting
 * `manifest.json` + `openapi.json`).
 *
 * Builds the app, generates the SDK package(s) from the compiled artifacts,
 * packs them into npm tarballs, then optionally:
 *   --push       git-tag the SDK (sdk-v<version>) and push to origin
 *   --publish    npm publish (private registry via --registry / SDK_NPM_REGISTRY)
 *   --release    create a GitHub release with the packed tarball (gh CLI or token)
 *
 * Usage (from repo root):
 *   bun scripts/generate-sdk.ts                       # generate + pack only
 *   bun scripts/generate-sdk.ts --platform all        # typescript + openapi spec
 *   bun scripts/generate-sdk.ts --push                # + git tag sdk-v<version>
 *   bun scripts/generate-sdk.ts --publish             # + npm publish
 *   bun scripts/generate-sdk.ts --release             # + GitHub release w/ tarball
 *   bun scripts/generate-sdk.ts --dry-run             # generate, print the plan
 *
 * Env overrides: APP_DIR (default packages/app), SDK_NAME, SDK_SCOPE,
 * SDK_VERSION, SDK_NPM_REGISTRY, GITHUB_TOKEN / GH_TOKEN.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createSdkGithubRelease,
  packSdk,
  publishSdkToNpm,
  resolveRepoUrl,
  tagSdkVersion,
  writeSdk,
} from "@ignex/compiler";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const APP_DIR = resolve(ROOT, process.env.APP_DIR ?? "packages/app");
const DIST = join(APP_DIR, "dist");

const VALUE_FLAGS = new Set([
  "platform",
  "name",
  "scope",
  "version",
  "out",
  "tag-prefix",
  "registry",
  "access",
  "dist-tag",
  "repo",
  "token",
]);

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

const flag = (flags: Record<string, string | boolean>, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

const has = (flags: Record<string, string | boolean>, name: string): boolean =>
  flags[name] === true;

/** Pack every package, then tag/publish/release per the flags. */
const distribute = (
  flags: Record<string, string | boolean>,
  result: Awaited<ReturnType<typeof writeSdk>>,
  version: string,
  tagPrefix: string,
): void => {
  const tarballs = new Map<string, string>();
  for (const pkg of result.packages) {
    const tarball = packSdk(pkg.dir);
    tarballs.set(pkg.platform, tarball);
    console.log(`✔ Packed ${pkg.platform} SDK → ${tarball}`);
  }

  if (has(flags, "push")) {
    const tag = tagSdkVersion({ version, tagPrefix, push: true, cwd: ROOT });
    console.log(`✔ Pushed tag ${tag} to origin`);
  }

  if (has(flags, "release")) {
    const tag = tagSdkVersion({ version, tagPrefix, push: has(flags, "push"), cwd: ROOT });
    const tarball = tarballs.get("typescript") ?? [...tarballs.values()][0];
    const ghRepo = flag(flags, "repo");
    const ghToken = flag(flags, "token");
    const repo = createSdkGithubRelease({
      tag,
      cwd: ROOT,
      ...(tarball !== undefined ? { tarball } : {}),
      ...(ghRepo !== undefined ? { repo: ghRepo } : {}),
      ...(ghToken !== undefined ? { token: ghToken } : {}),
    });
    console.log(`✔ GitHub release ${tag} created on ${repo}`);
  }

  if (has(flags, "publish")) {
    for (const pkg of result.packages) {
      const registry = flag(flags, "registry") ?? process.env.SDK_NPM_REGISTRY;
      publishSdkToNpm({
        dir: pkg.dir,
        access: flag(flags, "access") === "restricted" ? "restricted" : "public",
        distTag: flag(flags, "dist-tag") ?? "latest",
        ...(registry !== undefined ? { registry } : {}),
      });
      console.log(`✔ Published ${pkg.platform} SDK as ${pkg.platform}@${version}`);
    }
  }
};

/** The distribution plan to print in dry-run mode. */
const planOf = (
  flags: Record<string, string | boolean>,
  version: string,
  tagPrefix: string,
): string =>
  [
    has(flags, "push") ? `git tag ${tagPrefix}${version} + push` : null,
    has(flags, "release") ? `gh release create ${tagPrefix}${version} + tarball` : null,
    has(flags, "publish")
      ? `npm publish (${flag(flags, "registry") ?? process.env.SDK_NPM_REGISTRY ?? "configured registry"})`
      : null,
  ]
    .filter((step): step is string => step !== null)
    .join("; ") || "no distribution steps (generate only)";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = has(flags, "dry-run");

  if (!existsSync(join(APP_DIR, "package.json"))) {
    console.error(`✖ App not found at ${APP_DIR} — set APP_DIR or run from the repo root.`);
    process.exit(1);
  }

  if (!has(flags, "no-build")) {
    console.log("→ Building app …");
    const result = spawnSync("bun", ["run", "build"], { cwd: APP_DIR, stdio: "inherit" });
    if (result.status !== 0) {
      console.error("✖ App build failed — fix the build before generating the SDK.");
      process.exit(1);
    }
  }

  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  const version = flag(flags, "version") ?? process.env.SDK_VERSION ?? rootPkg.version ?? "0.0.0";

  const platformRaw = flag(flags, "platform") ?? "typescript";
  const platforms = platformRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((id) => (id === "all" ? ["typescript", "openapi", "flatbuffers"] : [id]));

  const name = flag(flags, "name") ?? process.env.SDK_NAME;
  const scope = flag(flags, "scope") ?? process.env.SDK_SCOPE;
  const out = flag(flags, "out");
  const repoUrl = process.env.SDK_REPO_URL ?? resolveRepoUrl(ROOT);

  const result = await writeSdk({
    outDir: DIST,
    ...(out !== undefined ? { packageDir: resolve(ROOT, out) } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    localInstallPath: out !== undefined ? resolve(ROOT, out) : join(DIST, "sdk"),
    version,
    platforms: platforms as "typescript"[],
  });

  for (const pkg of result.packages) {
    console.log(`✔ Generated ${pkg.platform} SDK in ${pkg.dir} (${pkg.files.length} files)`);
  }

  if (repoUrl === undefined) {
    console.log(
      `\n  No GitHub repo detected — test locally first:\n` +
        `    npm install ${result.rootDir}\n` +
        `  (once the repo exists, re-run with --push/--release to distribute)`,
    );
  }

  const tagPrefix = flag(flags, "tag-prefix") ?? "sdk-v";

  if (dryRun) {
    console.log(`[dry-run] ${planOf(flags, version, tagPrefix)}`);
    console.log(`✔ Dry run — SDK generated in ${result.rootDir}, nothing pushed/published.`);
    return;
  }

  distribute(flags, result, version, tagPrefix);

  console.log("\n✔ SDK complete.");
}

await main();
