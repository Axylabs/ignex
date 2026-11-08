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
import type { SdkOptions, SdkPlatformId } from "@ignex/compiler";
import {
  createSdkGithubRelease,
  packSdk,
  publishSdkToNpm,
  resolveRepoUrl,
  tagSdkVersion,
  writeSdk,
} from "@ignex/compiler";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import type { SdkProjectOptions } from "../config.js";
import { buildProject } from "../utils/compiler.js";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error, formatError, info, success } from "../utils/logger.js";
import { emitRealtimeArtifact } from "../utils/realtime-artifact.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  root: { type: "string", valueHint: "dir", description: "Project root" },
  platform: {
    type: "string",
    valueHint: "typescript|openapi|realtime|all",
    description: "Comma-separated SDK platforms (default typescript)",
  },
  name: {
    type: "string",
    valueHint: "pkg",
    description: "SDK package name (default: app SDK name)",
  },
  scope: { type: "string", valueHint: "@scope", description: "npm scope" },
  version: {
    type: "string",
    valueHint: "x.y.z",
    description: "SDK version (default: nearest package.json)",
  },
  out: { type: "string", valueHint: "dir", description: "SDK package output dir" },
  license: { type: "string", valueHint: "SPDX", description: "SDK package license" },
  description: { type: "string", valueHint: "text", description: "SDK package description" },
  "tag-prefix": {
    type: "string",
    valueHint: "prefix",
    description: "Git tag prefix (default sdk-v)",
  },
  push: { type: "boolean", description: "Tag + push the SDK version to git" },
  publish: { type: "boolean", description: "npm publish each platform package" },
  release: { type: "boolean", description: "Attach the packed tarball to a GitHub release" },
  registry: { type: "string", valueHint: "url", description: "npm registry for --publish" },
  access: {
    type: "string",
    valueHint: "public|restricted",
    description: "npm access for scoped packages (default public)",
  },
  "dist-tag": {
    type: "string",
    valueHint: "tag",
    description: "npm dist-tag (default latest)",
  },
  token: { type: "string", valueHint: "token", description: "GitHub token (default: env)" },
  repo: {
    type: "string",
    valueHint: "owner/repo",
    description: "GitHub repo (default: origin remote)",
  },
  "dry-run": { type: "boolean", description: "Generate + print the plan, distribute nothing" },
  "no-build": { type: "boolean", description: "Skip the rebuild; use existing artifacts" },
} satisfies ArgsDef;

const sdkCmd = defineCommand({
  meta: metaFor("sdk"),
  args: argsDef,
  async run(ctx) {
    await runSdk(ctx.rawArgs);
  },
});

export default sdkCmd;

interface SdkCommandArgs {
  root: string;
  sdk: SdkProjectOptions;
  platforms: SdkOptions["platforms"];
  name: string | undefined;
  scope: string | undefined;
  version: string | undefined;
  out: string | undefined;
  license: string | undefined;
  description: string | undefined;
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

const parseSdkArgs = async (args: string[]): Promise<SdkCommandArgs> => {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);
  const root = await resolveProjectRoot(parsed.root);
  const project = await loadConfig(root);
  if (
    project.sdk !== undefined &&
    (project.sdk === null || typeof project.sdk !== "object" || Array.isArray(project.sdk))
  ) {
    throw new Error("The 'sdk' project config must be a plain options object");
  }
  const sdk = (project.sdk ?? {}) as SdkProjectOptions;
  const cliPlatforms = parsed.platform
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => (id === "all" ? "typescript,openapi,realtime" : id))
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SdkPlatformId[] | undefined;

  const access = parsed.access === "restricted" ? "restricted" : "public";

  return {
    root,
    sdk,
    platforms: cliPlatforms ?? sdk.platforms,
    name: parsed.name ?? process.env.SDK_NAME ?? sdk.name,
    scope: parsed.scope ?? process.env.SDK_SCOPE ?? sdk.scope,
    version: parsed.version ?? process.env.SDK_VERSION ?? sdk.version,
    out: parsed.out ?? sdk.packageDir,
    license: parsed.license ?? sdk.license,
    description: parsed.description ?? sdk.description,
    tagPrefix: parsed["tag-prefix"] ?? "sdk-v",
    push: parsed.push === true,
    publish: parsed.publish === true,
    release: parsed.release === true,
    registry: parsed.registry ?? process.env.SDK_NPM_REGISTRY,
    access,
    distTag: parsed["dist-tag"] ?? "latest",
    token: parsed.token,
    dryRun: parsed["dry-run"] === true,
    skipBuild: parsed["no-build"] === true,
    repo: parsed.repo,
  };
};

/** The SDK root directory (mirrors the generator's default package root). */
const resultRoot = (parsed: SdkCommandArgs, outDir: string): string =>
  parsed.out === undefined
    ? join(outDir, "sdk")
    : isAbsolute(parsed.out)
      ? parsed.out
      : join(parsed.root, parsed.out);

const sdkRepoUrl = (parsed: SdkCommandArgs): string | undefined =>
  (parsed.repo !== undefined ? `https://github.com/${parsed.repo}` : undefined) ??
  process.env.SDK_REPO_URL ??
  parsed.sdk.repoUrl ??
  resolveRepoUrl(parsed.root);

const sdkGenerationOptions = (
  parsed: SdkCommandArgs,
  outDir: string,
  version: string,
): SdkOptions => {
  const packageDir = resultRoot(parsed, outDir);
  const repoUrl = sdkRepoUrl(parsed);
  return {
    ...parsed.sdk,
    outDir,
    packageDir,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
    ...(parsed.license !== undefined ? { license: parsed.license } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    localInstallPath: packageDir,
    version,
    ...(parsed.platforms !== undefined ? { platforms: parsed.platforms } : {}),
  };
};

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
  const parsed = await parseSdkArgs(args);

  const platformNames = (parsed.platforms ?? ["typescript"])
    .map((platform) => (typeof platform === "string" ? platform : platform.id))
    .join(", ");
  info(`SDK: ${platformNames} for ${parsed.root}`);

  try {
    // The SDK is derived from the compiled artifacts, so (re)build first.
    let outDir: string;
    if (parsed.skipBuild) {
      const config = await loadConfig(parsed.root);
      outDir = (config.outDir as string | undefined) ?? ".ignex";
    } else {
      const { opts } = await buildProject(parsed.root, {});
      outDir = opts.outDir;
    }
    if (!isAbsolute(outDir)) outDir = join(parsed.root, outDir);

    // Refresh the realtime artifact (both paths above resolve outDir the same
    // way), so `--no-build` still picks up src/realtime.ts changes.
    if (await emitRealtimeArtifact(parsed.root, outDir)) {
      info(`Realtime artifact: ${join(outDir, "realtime.json")}`);
    }

    const version = parsed.version ?? versionFromPackage(parsed.root) ?? "0.0.0";
    const repoUrl = sdkRepoUrl(parsed);
    const result = await writeSdk(sdkGenerationOptions(parsed, outDir, version));

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
