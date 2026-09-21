/**
 * @fileoverview castrum package-location probing — the resolution ladder that
 * finds the castrum package dir and its addon binary (override → own `file:`
 * target → own node_modules symlink → workspace packages → upward
 * `node_modules` walk → bun's global link store), plus the x86-64-v3 SIMD
 * CPU-detect that picks the addon variant.
 *
 * Extracted from the pre-split `loader.ts` (move-only); `findCastrumDir`,
 * `findAddonPath` and `resolveCastrumEntryPath` are the public entry points
 * for the loader and the TS-integration fallback.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url)); // .../packages/native/src/loader
const pkgDir = dirname(dirname(srcDir)); // .../packages/native

/** Read our own package.json's castrum `file:` optionalDependency target. */
const castrumFromOwnPackage = (): string | null => {
  try {
    const own = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>;
    };
    const spec = own.optionalDependencies?.castrum;
    if (typeof spec !== "string" || !spec.startsWith("file:")) return null;
    const target = join(pkgDir, spec.slice("file:".length));
    return existsSync(join(target, "package.json")) ? target : null;
  } catch {
    return null;
  }
};

/** Resolve castrum via our own node_modules symlink (created by bun install). */
const castrumFromSymlink = (): string | null => {
  const symlink = join(pkgDir, "node_modules", "castrum");
  return existsSync(join(symlink, "package.json")) ? symlink : null;
};

/**
 * Resolve castrum via a `node_modules/castrum` entry at `ancestor` — covers
 * `bun link` (root symlink → `~/.bun/install/global/...`) and hoisted
 * installs in monorepos. Mirrors Node/Bun's own upward module resolution so
 * the live linked castrum is found even when no workspace package declares it
 * via a `file:`/registry dependency.
 */
const castrumFromNodeModules = (ancestor: string): string | null => {
  const linked = join(ancestor, "node_modules", "castrum");
  return existsSync(join(linked, "package.json")) ? linked : null;
};

/** Resolve castrum from bun's global link store (`~/.bun/install/global/...`). */
const castrumFromBunLink = (): string | null => {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const linked = join(home, ".bun", "install", "global", "node_modules", "castrum");
  return existsSync(join(linked, "package.json")) ? linked : null;
};

/** Collect the ancestor directories of `start` up to the filesystem root. */
const ancestorDirs = (start: string): string[] => {
  const roots: string[] = [];
  let cur = start;
  for (let i = 0; i < 64; i++) {
    roots.push(cur);
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return roots;
};

/** Resolve a workspace `packages/*` directory at `ancestor` that targets castrum. */
const castrumFromWorkspace = (ancestor: string): string | null => {
  let pkgs: string[] = [];
  try {
    pkgs = readdirSync(join(ancestor, "packages")).filter((e) => {
      try {
        return existsSync(join(ancestor, "packages", e, "package.json"));
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  for (const name of pkgs) {
    const pkgDir = join(ancestor, "packages", name);
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
        optionalDependencies?: Record<string, string>;
      };
      const spec = pkg.optionalDependencies?.castrum;
      if (typeof spec !== "string") {
        continue;
      }
      if (spec.startsWith("file:")) {
        const target = join(pkgDir, spec.slice("file:".length));
        if (existsSync(join(target, "package.json"))) return target;
      }
      // Registry-installed castrum (e.g. "^0.9.0"): resolve via the workspace
      // package's node_modules, which bun links during install. This keeps the
      // compiled/bundled entry (e.g. `packages/app/dist/__server.js`) native
      // when the package no longer declares castrum via a `file:` target.
      const installed = join(pkgDir, "node_modules", "castrum");
      if (existsSync(join(installed, "package.json"))) return installed;
    } catch {
      /* ignore */
    }
  }
  return null;
};

/**
 * Candidate castrum package directories, in resolution order.
 *
 * 1. The `file:` target from our package.json — the canonical dev setup
 *    (points at the live repo with the freshly-built addon + TS entry).
 * 2. Our own node_modules symlink (created by bun install for the `file:` dep).
 * 3. Workspace castrum (bundled-entry fallback): when this module is inlined
 *    into a bundled entry (e.g. `packages/app/dist/__server.js`),
 *    `import.meta.url` points at the app (or the dist dir), so the steps
 *    above may not resolve. Walk up from the module dir AND cwd to the
 *    filesystem root; at each ancestor with a `packages/` directory, look for
 *    a workspace package that declares `optionalDependencies.castrum` and
 *    resolve that package's OWN `node_modules/castrum` (the version the
 *    lockfile resolved for `@ignex/native`) — or a `file:` target pointing at
 *    the LIVE castrum repo (with the freshly-built addon). This runs BEFORE
 *    the generic `node_modules` walk so a stale hoisted copy at the workspace
 *    root cannot shadow the correct version.
 * 4. `bun link` / hoisted `node_modules/castrum`: walk up from the module dir
 *    AND cwd (Node/Bun's own upward resolution) and use the first ancestor's
 *    `node_modules/castrum` — covers the project linked through `bun link`
 *    (root symlink → `~/.bun/install/global/...`) and hoisted monorepo
 *    installs, with no env override required.
 * 5. bun's global link store (`~/.bun/install/global/node_modules/castrum`)
 *    directly, for projects outside a linked tree.
 */
export const findCastrumDir = (): string | null =>
  // When IGNEX_NATIVE_PATH points at a `.node` built from a local castrum
  // checkout, resolve that SAME checkout's package dir first — the TS
  // integration layer (createPipeline / MetricsRegistry …) must match the
  // loaded addon, not a registry copy that may have drifted from it.
  castrumFromOverride() ??
  castrumFromOwnPackage() ??
  castrumFromSymlink() ??
  // Workspace castrum BEFORE the generic ancestor `node_modules` walk. In a
  // bundled entry (`pkgDir` points at the app, not `@ignex/native`) the generic
  // walk can shadow the correct version with a STALE hoisted copy at the
  // workspace root; the workspace package's own `node_modules` holds the
  // version the lockfile resolved for `@ignex/native` (and `file:` targets
  // resolve the live repo). This is the loader's documented "bypass bun's
  // stale install cache" fallback for bundled entries.
  [...ancestorDirs(pkgDir), ...ancestorDirs(process.cwd())].reduce<string | null>(
    (found, ancestor) => found ?? castrumFromWorkspace(ancestor),
    null,
  ) ??
  [...ancestorDirs(pkgDir), ...ancestorDirs(process.cwd())].reduce<string | null>(
    (found, ancestor) => found ?? castrumFromNodeModules(ancestor),
    null,
  ) ??
  castrumFromBunLink();

/** True when the host CPU supports the x86-64-v3 SIMD feature set. */
const supportsX8664V3 = (): boolean => {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    return ["avx2", "bmi2", "fma", "sse4_2"].every((f) => new RegExp(`\\b${f}\\b`).test(cpuinfo));
  } catch {
    return false;
  }
};

/** Find the addon binary (`*.node`) inside a castrum package directory. */
export const findAddonPath = (dir: string): string | null => {
  const scan = (d: string): string | null => {
    try {
      const files = readdirSync(d).filter((e) => e.endsWith(".node"));
      if (files.length === 0) return null;
      // Dual-binary CPU-detect: castrum ships a baseline + an x86-64-v3 SIMD
      // variant; prefer the v3 one when the host CPU supports it, else the
      // baseline (v3 is never chosen on an unsupported CPU — a SIGILL on a
      // non-v3 machine is not catchable from JS).
      const v3 = supportsX8664V3() ? files.find((e) => e.includes("-v3-")) : undefined;
      const chosen = v3 ?? files.find((e) => !e.includes("-v3-")) ?? files[0];
      return chosen ? join(d, chosen) : null;
    } catch {
      return null;
    }
  };
  return scan(dir) ?? scan(join(dir, "dist"));
};

/** Resolve the castrum package entry (index.ts / dist/index.js) by absolute path. */
export const resolveCastrumEntryPath = (dir: string): string | null => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
      module?: string;
      main?: string;
    };
    const dot = (pkg.exports?.["."] ?? {}) as Record<string, string>;
    const entry = dot.bun ?? dot.node ?? dot.default ?? pkg.module ?? pkg.main;
    if (typeof entry !== "string") return null;
    const abs = join(dir, entry);
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the castrum package dir hosting `IGNEX_NATIVE_PATH`'s `.node`
 * (native-prep builds castrum from source and points the override into that
 * checkout). Walks up from the addon to the nearest dir with a resolvable
 * package entry, so the TS integration layer used by the surface gate and
 * `createNativePipeline` comes from the identical revision as the loaded
 * addon. Returns `null` for standalone `.node` files or when the override is
 * unset — those keep the registry/hoisted resolution below.
 */
const castrumFromOverride = (): string | null => {
  const override = process.env.IGNEX_NATIVE_PATH;
  if (typeof override !== "string" || !override.endsWith(".node")) return null;
  let dir = dirname(override);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, "package.json")) && resolveCastrumEntryPath(dir) !== null) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
};
