/**
 * Shared dependency helpers for scaffold commands (`model`, `resource`,
 * `hotroute`).
 *
 * `ensureDeps` makes the packages a generated file imports actually available:
 * it writes any missing entries into `package.json` AND runs the project's own
 * package manager (`bun add` / `pnpm add` / …) so the scaffolded model/resource
 * resolves its imports immediately — no "you forgot to install this" dance.
 *
 * The install is best-effort and never blocks the scaffold:
 *   - skipped under vitest (`NODE_ENV=test`) and via `IGNEX_NO_INSTALL=1`;
 *   - on failure (offline, no registry access) the `package.json` edit still
 *     lands and the CLI prints the manual command.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exists, readTextFile, writeFileEnsuringDir } from "./fs.js";
import { success, warn } from "./logger.js";

/** Skip the real package-manager install in tests or when opted out. */
const skipInstall = (): boolean =>
  process.env.NODE_ENV === "test" || process.env.IGNEX_NO_INSTALL === "1";

/** Detect the project's package manager from its lockfile (bun default). */
export async function detectPackageManager(root: string): Promise<string> {
  const locks: ReadonlyArray<readonly [string, string]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of locks) {
    if (await exists(join(root, file))) return pm;
  }
  return "bun"; // ignex is bun-first.
}

/** The install command + args for a package manager and dep list. */
const addArgs = (pm: string, deps: readonly string[]): [string, string[]] => {
  switch (pm) {
    case "npm":
      return ["npm", ["install", ...deps]];
    case "pnpm":
      return ["pnpm", ["add", ...deps]];
    case "yarn":
      return ["yarn", ["add", ...deps]];
    default:
      return ["bun", ["add", ...deps]];
  }
};

/**
 * Ensure `deps` are present in the project at `root`: write any missing ones
 * into `package.json` and, when possible, run the package manager so they are
 * actually installed (lockfile + node_modules). Idempotent — no-ops when every
 * dep is already listed.
 */
export async function ensureDeps(root: string, deps: readonly string[]): Promise<void> {
  if (deps.length === 0) return;

  const pkgPath = join(root, "package.json");
  if (!(await exists(pkgPath))) return; // no manifest — nothing to edit or install into

  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readTextFile(pkgPath)) as { dependencies?: Record<string, string> };
  } catch {
    warn(`Could not read ${pkgPath} — install manually: bun add ${deps.join(" ")}`);
    return;
  }
  if (!pkg.dependencies) pkg.dependencies = {};

  const missing = deps.filter((dep) => !pkg.dependencies?.[dep]);
  if (missing.length === 0) return;

  // Prefer a real install: it resolves proper versions and writes the lockfile.
  if (!skipInstall()) {
    const pm = await detectPackageManager(root);
    const [cmd, args] = addArgs(pm, missing);
    const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", timeout: 120_000 });
    if (result.status === 0) {
      success(`Installed ${missing.join(", ")} (${pm} add).`);
      return;
    }
    warn(`Could not run "${cmd} ${args.join(" ")}" — adding to package.json instead.`);
    // A partial install may have added some deps already — re-read and only
    // fill what is still missing so we never downgrade a resolved version to
    // "latest".
    try {
      pkg = JSON.parse(await readTextFile(pkgPath)) as {
        dependencies?: Record<string, string>;
      };
      pkg.dependencies ??= {};
    } catch {
      // keep the pre-install view — the edit below is still better than nothing
    }
  }

  const depsMap = pkg.dependencies ?? {};
  const stillMissing = missing.filter((dep) => !depsMap[dep]);
  if (stillMissing.length === 0) return;
  for (const dep of stillMissing) depsMap[dep] = "latest";
  await writeFileEnsuringDir(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  success(`Added ${stillMissing.join(", ")} to package.json dependencies.`);
}
