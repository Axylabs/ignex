/**
 * @fileoverview Native acceleration status for developer-facing CLI output.
 *
 * `@ignex/native` is imported lazily so commands that never surface native
 * status (create/route/hook) pay no load cost, and so a missing optional addon
 * can never crash the CLI — native is a pure acceleration layer with
 * byte-compatible pure-TS fallbacks.
 */

/** Resolved native acceleration state (addon presence + active backend). */
export interface NativeStatus {
  /** True when the Rust addon is loaded and available. */
  readonly available: boolean;
  /** Active execution backend name ("castrum" | "js" | "unknown"). */
  readonly backend: string;
}

let cached: NativeStatus | null = null;

/**
 * Resolve native availability once per process (addon state is static).
 *
 * Any import failure degrades to `{ available: false }` — the CLI must never
 * crash because an optional acceleration layer is missing.
 */
export async function nativeStatus(): Promise<NativeStatus> {
  if (cached) return cached;

  try {
    const mod = await import("@ignex/native");
    cached = {
      available: mod.isNativeAvailable(),
      backend: mod.backendName(),
    };
  } catch {
    cached = { available: false, backend: "unknown" };
  }

  return cached;
}

/**
 * Human-readable one-liner for build/dev/info output.
 *
 * @param status - The resolved native status.
 * @returns A short label like "native (castrum)" or "off (pure-TS fallback)".
 */
export function nativeLabel(status: NativeStatus): string {
  return status.available ? `native (${status.backend})` : "off (pure-TS fallback)";
}
