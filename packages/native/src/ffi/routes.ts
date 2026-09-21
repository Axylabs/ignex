/**
 * @fileoverview Per-route C-ABI surface (`castrum_route_*`) — lazy dlopen in
 * its own transport so a castrum build without the route stack cannot break
 * the primary `FfiSurface`.
 *
 * Extracted from the pre-split `ffi.ts` (move-only).
 */
import { createRequire } from "node:module";
import { getAddonPath } from "../loader";
import type { FfiRouteSurface } from "./types";

let routeCached: FfiRouteSurface | null | undefined;

/** Lazy bind of the per-route C-ABI surface (`null` when the addon lacks it). */
export const getFfiRoute = (): FfiRouteSurface | null => {
  if (routeCached !== undefined) return routeCached;
  routeCached = null;
  if (process.env.IGNEX_NATIVE === "off") return null;

  const path = getAddonPath();
  if (!path) return null;

  type DlopenFn = (
    path: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => { symbols: Record<string, (...a: unknown[]) => number | bigint | undefined>; close(): void };

  let dlopen: DlopenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = createRequire(import.meta.url)("bun:ffi") as { dlopen: DlopenFn };
    dlopen = mod.dlopen;
  } catch {
    return null;
  }

  try {
    const { symbols } = dlopen(path, {
      castrum_route_compile: { args: ["ptr", "usize"], returns: "u64" },
      castrum_route_run: {
        args: ["u64", "ptr", "usize", "ptr", "usize"],
        returns: "usize",
      },
      castrum_route_destroy: { args: ["u64"], returns: "void" },
    });
    const s = symbols as Record<string, (...a: unknown[]) => number | bigint | undefined>;
    // Treat a PARTIAL binding (some symbols present, others silently
    // `undefined` → always-0 results) as "surface absent" so the JS prelude
    // remains the fallback instead of a half-working native path.
    const required = [
      "castrum_route_compile",
      "castrum_route_run",
      "castrum_route_destroy",
    ] as const;
    if (required.some((name) => typeof s[name] !== "function")) return null;
    routeCached = {
      routeCompile: (descriptor) =>
        BigInt(s.castrum_route_compile?.(descriptor, descriptor.length) ?? 0n),
      routeRun: (handle, frame, out) =>
        Number(s.castrum_route_run?.(handle, frame, frame.length, out, out.length) ?? 0),
      routeDestroy: (handle) => {
        s.castrum_route_destroy?.(handle);
      },
    };
  } catch {
    // Addon lacks the route surface — not an error.
    routeCached = null;
  }
  return routeCached;
};
