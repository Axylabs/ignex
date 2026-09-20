/**
 * @fileoverview Native addon loader state — FIRST-CLASS Rust support.
 *
 * Loads the castrum NAPI addon (.node binary) once, lazily, and NEVER throws:
 * when the addon is missing (or fails to load) we fall back to the pure-TS
 * implementations, so ignex works everywhere and native is purely an
 * acceleration layer. Holds the module-level `native` singleton, the memoized
 * addon path shared with the C-ABI transport, and the public accessors.
 *
 * Why not `import("castrum")`? The bare specifier is mapped by the root
 * tsconfig `paths` to `./vendor/castrum.d.ts` (a type-only stub), and Bun
 * honors tsconfig `paths` at runtime — so a bare import would resolve to an
 * empty module. Instead we locate the castrum package directory via
 * `@ignex/native`'s own `node_modules` symlink (or the `file:` target from our
 * package.json) and load the addon BINARY directly. Node-API modules must be
 * loaded with `require`/`process.dlopen`, not ESM `import`.
 *
 * Extracted from the pre-split `loader.ts` (move-only); the package-location
 * ladder moved to `./paths`, the require/guard plumbing to `./require`, and
 * the eager-init calls to `./init`.
 */

import { pathToFileURL } from "node:url";
import { findAddonPath, findCastrumDir, resolveCastrumEntryPath } from "./paths";
import { isNativeSurface, normalize, reportLoadFailure, requireAddon } from "./require";
import type { NativeAddon } from "./types";

/** The loaded addon (or `null` when unavailable). Shared module state. */
export let native: NativeAddon | null = null;

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
