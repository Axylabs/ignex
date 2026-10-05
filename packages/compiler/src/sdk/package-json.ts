/**
 * @fileoverview Shared SDK packaging helpers — the package.json skeleton and
 * the README install snippet emitted by every generated SDK platform.
 */

import type { SdkGenerateContext } from "./types";

/** The platform-specific parts of one generated SDK package.json. */
export interface SdkPackageSpec {
  /** Resolved package name. */
  readonly name: string;
  /** Default description, used when the caller did not override it. */
  readonly description: string;
  /** The `exports` map (platform-specific entry points). */
  readonly exports: Record<string, unknown>;
  /** The `files` whitelist. */
  readonly files: readonly string[];
  /** Extra fields (dependencies, debugbar metadata, …) merged into the result. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Build the package.json object every generated SDK shares, merged with the
 * platform's `extra` fields and the optional repository override.
 */
export const sdkPackageJson = (
  ctx: SdkGenerateContext,
  spec: SdkPackageSpec,
): Record<string, unknown> => {
  const { options } = ctx;
  return {
    name: spec.name,
    version: options.version ?? "0.0.0",
    description: options.description ?? spec.description,
    type: "module",
    sideEffects: false,
    main: "./dist/index.js",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: spec.exports,
    files: spec.files,
    license: options.license ?? "MIT",
    engines: { node: ">=18" },
    ...spec.extra,
    ...(options.repoUrl !== undefined ? { repository: { type: "git", url: options.repoUrl } } : {}),
  };
};

/** The `npm install` snippet (with the GitHub-release fallback) for an SDK README. */
export const sdkInstallSnippet = (
  repoUrl: string | undefined,
  name: string,
  version: string,
): string =>
  repoUrl !== undefined
    ? `npm install ${name}
# or install directly from the GitHub release tarball:
npm install ${repoUrl}/releases/download/sdk-v${version}/${name.replace("@", "").replace("/", "-")}-${version}.tgz`
    : `npm install ${name}`;
