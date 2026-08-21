/**
 * @fileoverview SDK distribution: push the generated package to GitHub and/or
 * a (private) npm registry so frontend teams can install it.
 *
 * Three independent, composable steps:
 *
 * - {@link tagSdkVersion} — git tag (`sdk-v<version>`) + optional push to the
 *   origin remote ("push it to GitHub as a tag").
 * - {@link publishSdkToNpm} — `npm publish` with a configurable registry
 *   (defaults to the user's configured registry; point it at a private one
 *   with `--registry` / `SDK_NPM_REGISTRY`).
 * - {@link createSdkGithubRelease} — GitHub Release for the tag with the
 *   packed tarball attached, so clients can also `npm install <tarball-url>`.
 *
 * All steps honor `dryRun` (print the plan, change nothing) and run through
 * the standard CLIs (`git`, `npm`, `gh`), failing loudly with actionable
 * messages when a tool or credential is missing.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Options for {@link tagSdkVersion}. */
export interface SdkTagOptions {
  /** Version being released (`0.1.7`). */
  version: string;
  /** Tag prefix. Defaults to `sdk-v`. */
  tagPrefix?: string;
  /** Push the tag to `origin` after creating it. */
  push?: boolean;
  /** Directory git commands run in (the repo root). */
  cwd: string;
  /** Print the plan without touching git. */
  dryRun?: boolean;
}

/** Options for {@link publishSdkToNpm}. */
export interface SdkNpmPublishOptions {
  /** Package directory (must contain `package.json`). */
  dir: string;
  /** Registry URL override (private registry support). */
  registry?: string;
  /** npm access level for scoped packages. Defaults to `public`. */
  access?: "public" | "restricted";
  /** npm dist-tag. Defaults to `latest`. */
  distTag?: string;
  /** Print the plan without publishing. */
  dryRun?: boolean;
}

/** Options for {@link createSdkGithubRelease}. */
export interface SdkGithubReleaseOptions {
  /** Release tag name (e.g. `sdk-v0.1.7`). */
  tag: string;
  /** Tarball to attach as a release asset (optional). */
  tarball?: string;
  /** `owner/repo` — defaults to the origin remote of `cwd`. */
  repo?: string;
  /** GitHub token (`GITHUB_TOKEN`/`GH_TOKEN` env fallback). */
  token?: string;
  /** Release title. Defaults to the tag. */
  title?: string;
  /** Release notes (markdown). */
  notes?: string;
  /** Directory git commands run in (the repo root). */
  cwd: string;
  /** Print the plan without creating anything. */
  dryRun?: boolean;
}

/** Run a command synchronously; throw with stderr on failure. */
const run = (cmd: string, args: string[], cwd: string, label: string): void => {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`\`${label}\` failed (exit ${String(result.status)}). See output above.`);
  }
};

const tagName = (version: string, prefix: string): string => `${prefix}${version}`;

/**
 * Create (and optionally push) the SDK git tag.
 *
 * @param options - Version, tag prefix, repo cwd, dry-run/push flags.
 * @returns The tag name that was (or would be) created.
 */
export const tagSdkVersion = (options: SdkTagOptions): string => {
  const prefix = options.tagPrefix ?? "sdk-v";
  const tag = tagName(options.version, prefix);

  if (options.dryRun) {
    console.log(`[dry-run] git tag ${tag}${options.push ? ` && git push origin ${tag}` : ""}`);
    return tag;
  }

  const exists =
    spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      cwd: options.cwd,
      encoding: "utf8",
    }).status === 0;

  if (exists) {
    console.log(`✔ tag ${tag} already exists — skipping.`);
    return tag;
  }

  run("git", ["tag", tag], options.cwd, `git tag ${tag}`);
  if (options.push) {
    run("git", ["push", "origin", tag], options.cwd, `git push origin ${tag}`);
  }
  console.log(`✔ tagged ${tag}${options.push ? " and pushed to origin" : ""}`);
  return tag;
};

/**
 * Publish a generated SDK package to an npm registry.
 *
 * Auth comes from the standard npm sources: `NODE_AUTH_TOKEN` or your npm
 * config/`.npmrc` (a private registry can be selected via `registry`).
 *
 * @param options - Package dir, registry/access/dist-tag, dry-run flag.
 */
export const publishSdkToNpm = (options: SdkNpmPublishOptions): void => {
  const args = ["publish", options.dir];
  if (options.registry !== undefined) args.push("--registry", options.registry);
  args.push("--access", options.access ?? "public");
  args.push("--tag", options.distTag ?? "latest");

  if (options.dryRun) {
    console.log(`[dry-run] npm ${args.join(" ")}`);
    return;
  }
  run("npm", args, options.dir, `npm publish ${options.dir}`);
  console.log(`✔ published ${options.dir} to ${options.registry ?? "the configured registry"}`);
};

/** Extract `owner/repo` from a `git remote get-url origin` output. */
const repoFromRemote = (cwd: string): string | undefined => {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const url = result.stdout.trim();
  const match = /(?:github\.com[:/]|git@github\.com:)([^/]+\/[^/.]+)(?:\.git)?$/.exec(url);
  return match?.[1];
};

/**
 * Resolve the GitHub HTTPS repository URL (`https://github.com/owner/repo`)
 * from the `origin` remote of the repo at `cwd`, if it exists.
 *
 * @param cwd - The repo root to inspect.
 * @returns The HTTPS repo URL, or `undefined` when there is no GitHub remote.
 */
export const resolveRepoUrl = (cwd: string): string | undefined => {
  const repo = repoFromRemote(cwd);
  return repo !== undefined ? `https://github.com/${repo}` : undefined;
};

/** Encode a file path as a GitHub upload asset URL path segment. */
const assetName = (tarball: string): string => tarball.split(/[\\/]/).pop() ?? "sdk.tgz";

/**
 * Create a GitHub Release for the SDK tag, optionally attaching the packed
 * tarball so frontend clients can `npm install` it by URL.
 *
 * Uses the `gh` CLI when available; falls back to the GitHub REST API with a
 * `token` (or `GITHUB_TOKEN`/`GH_TOKEN`). Requires an `origin` remote (or an
 * explicit `repo`) in the repo at `cwd`.
 *
 * @param options - Tag, tarball, repo/token, notes, dry-run flag.
 * @returns The `owner/repo` the release was created against.
 */
export const createSdkGithubRelease = (options: SdkGithubReleaseOptions): string => {
  const repo = options.repo ?? repoFromRemote(options.cwd);
  if (repo === undefined) {
    throw new Error(
      "Cannot determine the GitHub repository — pass `--repo owner/repo` or add an `origin` remote.",
    );
  }

  const title = options.title ?? options.tag;
  const notes = options.notes ?? `Generated SDK for the ignex API — tag ${options.tag}.`;
  const asset = options.tarball !== undefined ? ` ${assetName(options.tarball)}` : "";

  if (options.dryRun) {
    console.log(
      `[dry-run] gh release create ${options.tag}${asset} --repo ${repo} --title "${title}"`,
    );
    return repo;
  }

  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (gh.status === 0) {
    const args = ["release", "create", options.tag];
    if (options.tarball !== undefined) args.push(options.tarball);
    args.push("--repo", repo, "--title", title, "--notes", notes);
    run("gh", args, options.cwd, `gh release create ${options.tag}`);
    console.log(`✔ created GitHub release ${options.tag} on ${repo}${asset}`);
    return repo;
  }

  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined) {
    throw new Error(
      "Neither `gh` CLI nor a GitHub token (GITHUB_TOKEN/GH_TOKEN) is available for release creation.",
    );
  }

  const releaseBody = JSON.stringify({ tag_name: options.tag, name: title, body: notes });
  const create = spawnSync(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      `https://api.github.com/repos/${repo}/releases`,
      "-H",
      `Authorization: Bearer ${token}`,
      "-d",
      releaseBody,
    ],
    { cwd: options.cwd, encoding: "utf8" },
  );
  if (create.status !== 0) {
    throw new Error(`GitHub API release creation failed: ${create.stderr?.trim()}`);
  }
  const created = JSON.parse(create.stdout) as { id?: number; html_url?: string };
  if (created.id === undefined) {
    throw new Error(`GitHub API release creation failed: ${create.stdout}`);
  }
  console.log(
    `✔ created GitHub release ${options.tag} on ${repo} (${created.html_url ?? "see API"})`,
  );

  if (options.tarball !== undefined) {
    const upload = spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        `https://uploads.github.com/repos/${repo}/releases/${String(created.id)}/assets?name=${encodeURIComponent(assetName(options.tarball))}`,
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Content-Type: application/octet-stream",
        "--data-binary",
        `@${join(options.cwd, options.tarball)}`,
      ],
      { cwd: options.cwd, encoding: "utf8" },
    );
    if (upload.status !== 0) {
      throw new Error(`GitHub asset upload failed: ${upload.stderr?.trim()}`);
    }
    console.log(`✔ uploaded ${assetName(options.tarball)} to release ${options.tag}`);
  }
  return repo;
};
