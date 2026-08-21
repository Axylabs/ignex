/**
 * @fileoverview SDK generation orchestrator — the public entry point of the
 * Ignex SDK pipeline.
 *
 * Flow: {@link generateSdk} loads the compiled app's artifacts
 * (`manifest.json` + `openapi.json` from `outDir`), resolves the requested
 * platforms, and produces one package per platform. {@link writeSdk} writes
 * those packages to disk; {@link packSdk} turns one into an npm tarball.
 *
 * The output is deterministic: same artifacts in → same files out.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadSdkInputs } from "./load";
import { openapiPlatform } from "./openapi";
import type { SdkOptions, SdkPackage, SdkPlatform, SdkPlatformId, SdkResult } from "./types";
import { typescriptPlatform } from "./typescript";

/** Registry of built-in platforms, keyed by id. */
export const sdkPlatforms: Readonly<Record<string, SdkPlatform>> = {
  typescript: typescriptPlatform,
  openapi: openapiPlatform,
};

/** Default platforms when `options.platforms` is omitted. */
export const DEFAULT_SDK_PLATFORMS: readonly SdkPlatformId[] = ["typescript"];

const isSdkPlatformId = (value: unknown): value is SdkPlatformId =>
  value === "typescript" || value === "openapi";

/** Resolve the platform ids for an options object, validating unknowns. */
const resolvePlatformIds = (options: SdkOptions): readonly SdkPlatformId[] => {
  const requested = options.platforms ?? DEFAULT_SDK_PLATFORMS;
  if (requested.length === 0) return DEFAULT_SDK_PLATFORMS;
  for (const id of requested) {
    if (!isSdkPlatformId(id)) {
      throw new Error(
        `Unknown SDK platform "${String(id)}" — supported: ${Object.keys(sdkPlatforms).join(", ")}`,
      );
    }
  }
  return [...new Set(requested)];
};

/** Default package root: `<outDir>/sdk`. */
const defaultPackageRoot = (options: SdkOptions): string =>
  resolve(options.packageDir ?? join(options.outDir, "sdk"));

/**
 * Generate SDK packages for the requested platforms from a compiled app.
 *
 * Pure generation: reads the artifacts and returns file lists; nothing is
 * written. Use {@link writeSdk} to materialize the packages on disk.
 *
 * @param options - Artifact dir + package naming/version/platform selection.
 * @returns The generated packages (files relative to each package dir).
 */
export const generateSdk = async (options: SdkOptions): Promise<SdkResult> => {
  const inputs = loadSdkInputs(resolve(options.outDir));
  const platformIds = resolvePlatformIds(options);
  const rootDir = defaultPackageRoot(options);
  const multi = platformIds.length > 1;

  const packages: SdkPackage[] = [];
  for (const id of platformIds) {
    const platform = sdkPlatforms[id];
    if (platform === undefined) {
      throw new Error(
        `Unknown SDK platform "${id}" — supported: ${Object.keys(sdkPlatforms).join(", ")}`,
      );
    }
    const platformOptions: SdkOptions = {
      ...options,
      // With several platforms, keep package names + local install paths
      // distinct (one subdirectory per platform).
      ...(multi && options.name !== undefined ? { name: `${options.name}-${id}` } : {}),
      ...(options.localInstallPath !== undefined
        ? {
            localInstallPath: multi ? join(options.localInstallPath, id) : options.localInstallPath,
          }
        : {}),
    };
    const ctx = {
      routes: inputs.routes,
      openapi: inputs.openapi,
      serviceName: inputs.serviceName,
      options: platformOptions,
    };
    const dir = multi ? join(rootDir, id) : rootDir;
    packages.push({ platform: id, dir, files: platform.generate(ctx) });
  }

  return { rootDir, packages };
};

/**
 * Generate AND write the SDK packages to disk.
 *
 * @param options - Same options as {@link generateSdk}.
 * @returns The written packages.
 */
export const writeSdk = async (options: SdkOptions): Promise<SdkResult> => {
  const result = await generateSdk(options);
  for (const pkg of result.packages) {
    for (const file of pkg.files) {
      const abs = join(pkg.dir, file.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content, "utf8");
    }
  }
  return result;
};

/**
 * Pack a generated SDK directory into an npm tarball (`npm pack`).
 *
 * @param packageDir - Directory containing the SDK `package.json`.
 * @returns Absolute path of the produced `.tgz` tarball.
 */
export const packSdk = (packageDir: string): string => {
  const dir = resolve(packageDir);
  const result = spawnSync("npm", ["pack", "--json"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(
      `npm pack failed in ${dir}: ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { filename?: string }[];
  const filename = parsed[0]?.filename;
  if (filename === undefined) {
    throw new Error(`npm pack produced no tarball in ${dir}`);
  }
  return join(dir, filename);
};
