/**
 * Internal transport: JS object → wire frame via Rust FFI (or the pure-JS
 * encoder for user schemas without a native addon).
 * frame = `[1-byte event_id][size-prefixed FlatBuffer]` — fully produced by Rust.
 *
 * Three paths:
 *   - DIRECT (flat events, generated): fields pushed straight into Rust as FFI
 *     args from a zero-alloc encoder — no JSON, no intermediate array, and a
 *     single reusable output scratch (`encodeToScratch`).
 *   - JSON fallback (events with vectors / nested tables): object → JSON →
 *     `fb_serialize` → Rust parses and builds (still allocates — documented).
 *   - JS fallback (user schemas without a native addon): the generated pure-JS
 *     encoder (`bindings.encodeFrame`) — correct everywhere, slower, and the
 *     default when `ffiMode: "optional"` and no addon is available.
 *
 * `createTransport(bindings)` is a per-schema factory: it owns its own scratch +
 * stats + FFI binding, so several servers with different schemas can coexist.
 * The module-level `defaultTransport` (built-in registry, Rust required) keeps
 * the historical singleton behavior — `encodeToScratch` / `encodeEvent` /
 * `getEncodeStats` remain re-exported for backwards compatibility.
 */

import { defaultBindings } from "../bindings/default";
import type { Bindings, DirectEncoder } from "../bindings/types";
import { createFfi, type FfiDl } from "../native/ffi";
import { createScratch, MIN_CAP } from "./scratch";
import { createStats } from "./stats";

export interface Transport {
  /**
   * Zero-allocation encode into the transport's shared output scratch. The
   * returned view is only valid until the next call — publish/send it
   * immediately (Bun copies). Accepts app events AND control events.
   */
  encodeToScratch(name: string, payload: unknown): Uint8Array;
  /** Owned copy (safe to hold) — used by tests/bench. One allocation. */
  encodeEvent(name: string, payload: unknown): Uint8Array;
  /** encode-path stats (direct vs json vs js). */
  getEncodeStats(): {
    direct: Record<string, number>;
    json: Record<string, number>;
    js: Record<string, number>;
  };
}

/**
 * Resolved direct-path record for one event — populated lazily on first encode
 * and immutable afterwards (a direct symbol that was disabled by the bind-time
 * self-test never re-enables, so caching the resolved call is safe).
 */
interface ResolvedDirect {
  /** generated zero-alloc encoder (absent for JSON-only events) */
  encoder?: DirectEncoder;
  /** resolved FFI symbol (undefined = symbol disabled → JSON fallback) */
  call: ((...args: unknown[]) => number) | undefined;
  /** per-event NUL pre-scan (absent when the event has no string fields) */
  hasNul?: (o: unknown) => boolean;
}

export function createTransport(bindings: Bindings): Transport {
  const scratch = createScratch();
  const stats = createStats();
  const resolvedDirect = new Map<string, ResolvedDirect>();

  // Lazily bound once: undefined = not yet resolved, null = JS-only mode,
  // FfiDl = bound addon. For ffiMode "required" the bind throws (missing /
  // mismatched addon fails on first encode, as before); for "optional" it
  // resolves to null and the JS encoder is used.
  let ffi: FfiDl | null | undefined;
  const getFfiDl = (): FfiDl | null => {
    if (ffi === undefined) ffi = createFfi(bindings);
    return ffi;
  };

  const guard = bindings.ffiMode === "optional";

  function resolveDirect(name: string): ResolvedDirect {
    let r = resolvedDirect.get(name);
    if (r === undefined) {
      r = { call: undefined };
      const encoder = bindings.direct?.encoders[name];
      if (encoder) {
        r.encoder = encoder;
        const dl = getFfiDl();
        const symName = bindings.direct?.symbolNames[name];
        r.call = dl ? dl.raw[symName ?? ""] : undefined;
        const hasNul = bindings.direct?.hasNul[name];
        if (hasNul !== undefined) r.hasNul = hasNul;
      }
      resolvedDirect.set(name, r);
    }
    return r;
  }

  function encodeToScratch(name: string, payload: unknown): Uint8Array {
    const r = resolveDirect(name);
    const encoder = r.encoder;
    if (encoder && r.call) {
      // `call` is undefined when the bind-time self-test disabled the symbol —
      // fall through to the JSON path (graceful degradation). Embedded NULs route
      // to JSON too: the `cstring` direct path truncates them (silent data loss),
      // the JSON path preserves them exactly.
      if (!(r.hasNul?.(payload) ?? false)) {
        if (!guard) {
          // required mode — zero-alloc hot path, no try/catch
          scratch.grow(MIN_CAP);
          const w = scratch.neededSize(name, encoder(r.call, payload, scratch.view), () =>
            encoder(r.call!, payload, scratch.view),
          );
          stats.bump(name, "direct");
          return scratch.view.subarray(0, w);
        }
        try {
          scratch.grow(MIN_CAP);
          const w = scratch.neededSize(name, encoder(r.call, payload, scratch.view), () =>
            encoder(r.call!, payload, scratch.view),
          );
          stats.bump(name, "direct");
          return scratch.view.subarray(0, w);
        } catch {
          // optional mode: a direct-call failure (e.g. ABI drift at runtime)
          // permanently demotes this event to the JSON path.
          r.call = undefined;
        }
      }
    }

    const dl = getFfiDl();
    if (dl) {
      // JSON fallback (vector/nested events, or a disabled direct symbol).
      const id = bindings.anyEventNameToId[name];
      if (id === undefined) throw new Error(`ignex: unknown event "${name}"`);
      const json = JSON.stringify(payload);
      const ffi2 = dl.bindings;
      scratch.grow(Math.max(MIN_CAP, json.length * 2 + 128));
      const w = scratch.neededSize(name, ffi2.fb_serialize(id, json, scratch.view), () =>
        ffi2.fb_serialize(id, json, scratch.view),
      );
      stats.bump(name, "json");
      return scratch.view.subarray(0, w);
    }

    // JS-only mode (user schema, no native addon) — the pure-JS encoder.
    const frame = bindings.encodeFrame(name, payload);
    stats.bump(name, "js");
    return frame;
  }

  function encodeEvent(name: string, payload: unknown): Uint8Array {
    const frame = encodeToScratch(name, payload);
    const owned = new Uint8Array(frame.byteLength);
    owned.set(frame);
    return owned;
  }

  return {
    encodeToScratch,
    encodeEvent,
    getEncodeStats: () => stats.get(),
  };
}

// ── default transport (built-in registry) ──────────────────────────────────
// Module-level singleton — the historical zero-alloc hot path. Re-exported
// below so existing imports (`outbound.ts` migration aside) keep working.

export const defaultTransport: Transport = createTransport(defaultBindings);

/** Zero-allocation encode into the shared output scratch (built-in registry). */
export function encodeToScratch(name: string, payload: unknown): Uint8Array {
  return defaultTransport.encodeToScratch(name, payload);
}

/** Owned copy (safe to hold) — used by tests/bench. One allocation. */
export function encodeEvent(name: string, payload: unknown): Uint8Array {
  return defaultTransport.encodeEvent(name, payload);
}

/** encode-path stats for the built-in registry (direct vs JSON). */
export function getEncodeStats(): {
  direct: Record<string, number>;
  json: Record<string, number>;
  js: Record<string, number>;
} {
  return defaultTransport.getEncodeStats();
}
