/**
 * Native addon loader — FIRST-CLASS Rust support.
 *
 * Loads the castrum NAPI addon (.node binary) once, lazily, and NEVER throws:
 * when the addon is missing (or fails to load) we fall back to the pure-TS
 * implementations, so ignex works everywhere and native is purely an
 * acceleration layer.
 *
 * Why not `import("castrum")`? The bare specifier is mapped by the root
 * tsconfig `paths` to `./vendor/castrum.d.ts` (a type-only stub), and Bun
 * honors tsconfig `paths` at runtime — so a bare import would resolve to an
 * empty module. Instead we locate the castrum package directory via
 * `@ignex/native`'s own `node_modules` symlink (or the `file:` target from our
 * package.json) and load the addon BINARY directly. Node-API modules must be
 * loaded with `require`/`process.dlopen`, not ESM `import`.
 *
 * Resolution order:
 *   1. `IGNEX_NATIVE_PATH` — explicit override (.node path or module specifier).
 *   2. The castrum package's `*.node` binary (scanned in the package root,
 *      then `dist/`).
 *   3. The castrum package entry (index.ts under Bun / dist/index.js) via an
 *      absolute path, normalized as `default ?? rust ?? module` — covers
 *      setups where only the TS entry is present.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportDegradation } from "./telemetry";
import type * as Castrum from "./vendor/castrum";

/** The typed surface of the loaded addon. */
export type NativeAddon = typeof Castrum;

let native: NativeAddon | null = null;

/** True when a module exposes the expected native function surface. */
const isNativeSurface = (mod: unknown): mod is NativeAddon => {
  const m = mod as Record<string, unknown>;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.fnv1a64 === "function" &&
    typeof m.crc32 === "function" &&
    typeof m.jwtSign === "function"
  );
};

// ── castrum package location ────────────────────────────────────

const srcDir = dirname(fileURLToPath(import.meta.url)); // .../packages/native/src
const pkgDir = dirname(srcDir); // .../packages/native

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
const findCastrumDir = (): string | null =>
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
const findAddonPath = (dir: string): string | null => {
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
const resolveCastrumEntryPath = (dir: string): string | null => {
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

/** Load a Node-API `.node` binary via require (required for napi modules). */
const requireAddon = (nodePath: string): unknown => {
  const require = createRequire(import.meta.url);
  const mod = require(nodePath) as { default?: unknown };
  return mod.default ?? mod;
};

/** Normalize an entry module into the flat native surface. */
const normalize = (mod: unknown): unknown =>
  (mod as { default?: unknown }).default ?? (mod as { rust?: unknown }).rust ?? mod;

/**
 * One-time load-failure report. ALWAYS routed through the telemetry sink
 * (previously debug-gated — a broken addon install degraded every op to JS
 * with zero signal in production); `IGNEX_NATIVE=debug` additionally logs the
 * raw error detail.
 */
let reportedLoadFailure = false;
const reportLoadFailure = (err: unknown): void => {
  if (reportedLoadFailure) return;
  reportedLoadFailure = true;
  reportDegradation(
    "surface-missing",
    "addon.load",
    `castrum addon failed to load — all ops pinned to their pure-TS fallbacks${
      process.env.IGNEX_NATIVE === "debug"
        ? `: ${err instanceof Error ? err.message : String(err)}`
        : ""
    }`,
  );
  if (process.env.IGNEX_NATIVE === "debug") {
    console.info("[ignex-native] failed to load addon:", err);
  }
};

/** Resolved castrum `.node` binary path (or `null`). Cached for FFI/dlopen reuse. */
let addonPath: string | null | undefined;

/** Resolve + cache the `.node` binary path (or `null` when no binary exists). */
const resolveAddonPathOnce = (): string | null => {
  if (addonPath !== undefined) return addonPath;
  const override = process.env.IGNEX_NATIVE_PATH;
  if (override?.endsWith(".node")) {
    addonPath = override;
    return addonPath;
  }
  const dir = findCastrumDir();
  addonPath = dir ? findAddonPath(dir) : null;
  return addonPath;
};

const init = (async (): Promise<void> => {
  // Master switch: `IGNEX_NATIVE=off` disables the addon even when installed
  // (e.g. for parity debugging). Anything else (auto/unset) uses it when present.
  if (process.env.IGNEX_NATIVE === "off") return;

  try {
    const override = process.env.IGNEX_NATIVE_PATH;

    if (override) {
      const mod = override.endsWith(".node") ? requireAddon(override) : await import(override);
      native = isNativeSurface(normalize(mod)) ? (normalize(mod) as NativeAddon) : null;
      return;
    }

    const nodePath = resolveAddonPathOnce();

    if (nodePath) {
      const mod = requireAddon(nodePath);
      native = isNativeSurface(normalize(mod)) ? (normalize(mod) as NativeAddon) : null;
    } else {
      // No binary found — fall back to the castrum TS entry (absolute path).
      const dir = findCastrumDir();
      const entry = dir ? resolveCastrumEntryPath(dir) : null;
      if (entry) {
        const mod = await import(pathToFileURL(entry).href);
        native = isNativeSurface(normalize(mod)) ? (normalize(mod) as NativeAddon) : null;
      }
    }
  } catch (err) {
    native = null;
    reportLoadFailure(err);
  }
})();

await init;

/** The loaded addon (or `null` when unavailable). */
export const getNative = (): NativeAddon | null => native;

/**
 * The resolved castrum `.node` binary path (or `null` when unavailable).
 *
 * Shared with the C-ABI (`bun:ffi`) transport so it `dlopen`s the SAME addon
 * the NAPI loader `require`s — identical Rust cores, byte-identical contracts.
 */
export const getAddonPath = (): string | null => resolveAddonPathOnce();

/** True when the Rust addon is present and usable. */
export const isNativeAvailable = (): boolean => native != null;

/** Options for {@link initNative}. */
export interface NativeInitOptions {
  /**
   * Rayon worker-pool size. Only honored before the pool's first use (castrum
   * initializes on first batch op). Defaults to `max(1, cpus - 1)`.
   */
  threads?: number;
}

/** Result of {@link initNative}. */
export interface NativeInitResult {
  /** Whether the Rust addon is present and usable. */
  readonly available: boolean;
  /** Current rayon worker count after init (0 when unavailable / not yet used). */
  readonly rayonThreads: number;
}

let nativeInitialized = false;

/** Default rayon pool size: `max(1, hardwareConcurrency - 1)`. */
const defaultThreads = (): number => {
  const cpus =
    typeof navigator !== "undefined" && "hardwareConcurrency" in navigator
      ? navigator.hardwareConcurrency
      : 0;
  return Math.max(1, (cpus || 4) - 1);
};

/**
 * Eagerly initialize the Rust addon at boot — idempotent and NEVER throws.
 *
 * Pre-warms the rayon worker pool and forces the addon's initialization work
 * to happen during startup (load time) instead of lazily on the first request
 * (runtime). This is the explicit "sacrifice load time for runtime
 * performance" hook. Without the addon this is a harmless no-op.
 */
export const initNative = (options: NativeInitOptions = {}): NativeInitResult => {
  if (!native) return { available: false, rayonThreads: 0 };
  try {
    if (!nativeInitialized) {
      nativeInitialized = true;
      const initPool = native.initThreadPool;
      if (typeof initPool === "function") {
        initPool(options.threads ?? defaultThreads());
      }
    }
    const count = native.rayonNumThreads;
    return { available: true, rayonThreads: typeof count === "function" ? count() : 0 };
  } catch {
    return { available: false, rayonThreads: 0 };
  }
};

/**
 * Load the full castrum module (TS entry) — needed for features that only
 * exist in the TS integration layer (e.g. `createPipeline`, the ingress
 * route-manager adapter). Resolved by absolute path to bypass the tsconfig
 * `paths` stub. Returns `null` when unavailable.
 */
export const loadCastrumModule = async (): Promise<Record<string, unknown> | null> => {
  const dir = findCastrumDir();
  const entry = dir ? resolveCastrumEntryPath(dir) : null;
  if (!entry) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    return (
      (mod as { default?: Record<string, unknown> }).default ?? (mod as Record<string, unknown>)
    );
  } catch (err) {
    reportLoadFailure(err);
    return null;
  }
};
