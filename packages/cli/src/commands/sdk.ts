/**
 * @fileoverview `ignex sdk` — generate and distribute the app's SDK.
 *
 * Generates multi-platform SDK packages (TypeScript typed client by default)
 * from the compiled artifacts, then optionally pushes them to GitHub as a tag,
 * publishes to an npm registry, and/or attaches the packed tarball to a GitHub
 * release — so frontend teams can install the SDK for type-safe API calls.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SdkPlatformId } from "@ignex/compiler";
import {
  createSdkGithubRelease,
  packSdk,
  publishSdkToNpm,
  resolveRepoUrl,
  tagSdkVersion,
  writeSdk,
} from "@ignex/compiler";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { buildProject } from "../utils/compiler.js";
import { error, formatError, info, success } from "../utils/logger.js";

interface SdkCommandArgs {
  root: string;
  platforms: readonly SdkPlatformId[];
  name: string | undefined;
  scope: string | undefined;
  version: string | undefined;
  out: string | undefined;
  tagPrefix: string;
  push: boolean;
  publish: boolean;
  release: boolean;
  registry: string | undefined;
  access: "public" | "restricted";
  distTag: string;
  token: string | undefined;
  dryRun: boolean;
  skipBuild: boolean;
  repo: string | undefined;
}

/** Read the nearest package.json version up the tree from `root`. */
const versionFromPackage = (root: string): string | undefined => {
  let dir = isAbsolute(root) ? root : join(process.cwd(), root);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        version?: string;
      };
      if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
    } catch {
      // No package.json here — keep walking up.
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
};

const parseSdkArgs = (args: string[]): SdkCommandArgs => {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    platform: { type: "string" },
    name: { type: "string" },
    scope: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    "tag-prefix": { type: "string" },
    push: { type: "boolean" },
    publish: { type: "boolean" },
    release: { type: "boolean" },
    registry: { type: "string" },
    access: { type: "string" },
    "dist-tag": { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    "dry-run": { type: "boolean" },
    "no-build": { type: "boolean" },
  });

  const platformsRaw = (values.platform as string | undefined) ?? "typescript";
  const platforms = platformsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => (id === "all" ? "typescript,openapi,flatbuffers" : id))
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SdkPlatformId[];

  const access = values.access === "restricted" ? "restricted" : "public";

  return {
    root: resolveRoot(values, positionals),
    platforms,
    name: (values.name as string | undefined) ?? process.env.SDK_NAME,
    scope: (values.scope as string | undefined) ?? process.env.SDK_SCOPE,
    version: (values.version as string | undefined) ?? process.env.SDK_VERSION,
    out: values.out as string | undefined,
    tagPrefix: (values["tag-prefix"] as string | undefined) ?? "sdk-v",
    push: values.push === true,
    publish: values.publish === true,
    release: values.release === true,
    registry: (values.registry as string | undefined) ?? process.env.SDK_NPM_REGISTRY,
    access,
    distTag: (values["dist-tag"] as string | undefined) ?? "latest",
    token: values.token as string | undefined,
    dryRun: values["dry-run"] === true,
    skipBuild: values["no-build"] === true,
    repo: values.repo as string | undefined,
  };
};

/** The SDK root directory (mirrors the generator's default package root). */
const resultRoot = (parsed: SdkCommandArgs, outDir: string): string =>
  parsed.out !== undefined ? join(parsed.root, parsed.out) : join(outDir, "sdk");

/** Pack each generated package and run the requested distribution steps. */
const distributeSdk = (
  parsed: SdkCommandArgs,
  result: Awaited<ReturnType<typeof writeSdk>>,
  version: string,
): void => {
  const tarballs = new Map<string, string>();
  for (const pkg of result.packages) {
    const tarball = packSdk(pkg.dir);
    tarballs.set(pkg.platform, tarball);
    info(`Packed ${pkg.platform} SDK → ${tarball}`);
  }

  if (parsed.push) {
    const tag = tagSdkVersion({
      version,
      tagPrefix: parsed.tagPrefix,
      push: true,
      cwd: parsed.root,
    });
    info(`Pushed tag ${tag} to origin`);
  }

  if (parsed.release) {
    const tag = tagSdkVersion({
      version,
      tagPrefix: parsed.tagPrefix,
      push: parsed.push,
      cwd: parsed.root,
    });
    const tarball = tarballs.get("typescript") ?? [...tarballs.values()][0];
    const repo = createSdkGithubRelease({
      tag,
      tarball,
      repo: parsed.repo,
      token: parsed.token,
      cwd: parsed.root,
    });
    info(`GitHub release ${tag} created on ${repo}`);
  }

  if (parsed.publish) {
    for (const pkg of result.packages) {
      publishSdkToNpm({
        dir: pkg.dir,
        registry: parsed.registry,
        access: parsed.access,
        distTag: parsed.distTag,
      });
      info(`Published ${pkg.platform} SDK as ${pkg.platform}@${version}`);
    }
  }
};

export async function runSdk(args: string[]): Promise<void> {
  const parsed = parseSdkArgs(args);

  info(`SDK: ${parsed.platforms.join(", ")} for ${parsed.root}`);

  try {
    // The SDK is derived from the compiled artifacts, so (re)build first.
    let outDir: string;
    if (parsed.skipBuild) {
      const { loadConfig } = await import("../utils/config.js");
      const config = await loadConfig(parsed.root);
      outDir = (config.outDir as string | undefined) ?? ".ignex";
    } else {
      const { opts } = await buildProject(parsed.root, {});
      outDir = opts.outDir;
    }
    if (!isAbsolute(outDir)) outDir = join(parsed.root, outDir);

    const version = parsed.version ?? versionFromPackage(parsed.root) ?? "0.0.0";

    // Derive the GitHub repo URL from the origin remote (or --repo) so the
    // README can show the release-tarball install line once a repo exists.
    const repoUrl =
      process.env.SDK_REPO_URL ??
      resolveRepoUrl(parsed.root) ??
      (parsed.repo !== undefined ? `https://github.com/${parsed.repo}` : undefined);

    const result = await writeSdk({
      outDir,
      ...(parsed.out !== undefined ? { packageDir: parsed.out } : {}),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
      ...(repoUrl !== undefined ? { repoUrl } : {}),
      localInstallPath: resultRoot(parsed, outDir),
      version,
      platforms: parsed.platforms,
    });

    for (const pkg of result.packages) {
      info(`Generated ${pkg.platform} SDK in ${pkg.dir} (${pkg.files.length} files)`);
    }

    // No GitHub repo configured → give users a static path to test on their
    // device before anything is tagged/published.
    if (repoUrl === undefined) {
      console.log(
        `\n  No GitHub repo detected — test locally first:\n` +
          `    npm install ${result.rootDir}\n` +
          `  (once the repo exists, re-run with --push/--release to distribute)`,
      );
    }

    if (parsed.dryRun) {
      const plan =
        [
          parsed.push ? `git tag sdk-v${version} + push` : null,
          parsed.release ? `gh release create sdk-v${version} + tarball` : null,
          parsed.publish ? `npm publish (${parsed.registry ?? "configured registry"})` : null,
        ]
          .filter((step): step is string => step !== null)
          .join("; ") || "no distribution steps (generate only)";
      console.log(`[dry-run] ${plan}`);
      success(`Dry run — SDK generated in ${result.rootDir}, nothing pushed/published.`);
      return;
    }

    distributeSdk(parsed, result, version);

    success("SDK complete");
  } catch (err) {
    error(formatError(err));
    process.exitCode = 1;
  }
}
