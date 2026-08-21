/**
 * @fileoverview Accept negotiation (Accept-Encoding / Accept-Language).
 */

import { getFfiInstances } from "../ffi";
import { nativeFor } from "../runtime";
import { toBytes } from "../util";
import type { EncodingPrefResult } from "./types";

/**
 * A compiled content negotiation instance (specificity → q-value → order).
 */
export interface AcceptNegotiator {
  /** Best supported value for `header`, or `null` when nothing matches. */
  negotiate(header: string | null): string | null;
  /**
   * Best supported value for `header` with SERVER-preference tie-breaking
   * (q-only; the supported list's order decides ties — the semantic of ignex's
   * `negotiateEncoding` / compression plugin). Empty/absent header → `null`
   * (identity), unlike {@link negotiate} which returns the first supported.
   */
  negotiateServerPreference(header: string | null): string | null;
}

/** Parse an `Accept-Encoding` header into ordered `{encoding, q}` entries. */
export const parseAcceptEncoding = (input: string): EncodingPrefResult[] =>
  parseAcceptEncodingFallback(input);

/** Pure-TS fallback for {@link parseAcceptEncoding} (identical behavior). */
export const parseAcceptEncodingFallback = (input: string): EncodingPrefResult[] => {
  const out: EncodingPrefResult[] = [];
  if (!input) return out;
  let order = 0;
  for (const item of input.split(",")) {
    const [name, ...params] = item.trim().split(";");
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const eq = p.indexOf("=");
      if (eq >= 0 && p.slice(0, eq).trim() === "q") {
        const parsed = Number(p.slice(eq + 1).trim());
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    out.push({ encoding: name.trim().toLowerCase(), q, order: order++ });
  }
  return out;
};

/**
 * Compile a supported-value list once and negotiate headers against it.
 * Native-backed when the addon is available and the selection binds it
 * (`opImpl("createAcceptNegotiator") === "native"`, measured ~1.9× faster than
 * the JS engine on the compiled instance — see `scripts/bench-native.ts`).
 * Mirrors castrum's `AcceptNegotiator` (RFC 7231 §5.3.4): specificity first
 * (exact > `*`), then q-value, then earliest client order.
 *
 * NOTE: native wins on the STEADY-STATE negotiate call; constructing a native
 * instance per-request measures slower (~0.5×) — compile once and reuse (the
 * intended "compiled negotiator" contract).
 */
export const createAcceptNegotiator = (supported: string[]): AcceptNegotiator => {
  const n = nativeFor("createAcceptNegotiator");
  if (n && typeof n.AcceptNegotiator === "function") {
    try {
      const inst = new n.AcceptNegotiator(supported);
      // Opaque-handle C-ABI fast path — per-call `negotiate` drops from ~395ns
      // (NAPI) to ~125ns (C-ABI) on the compiled instance (bench 2026-08-16).
      const ffiInst = getFfiInstances();
      const inner = ffiInst ? Number(inst.innerPtr()) : 0;
      // Server-preference is a NEW napi method — absent on addons built before
      // the feature. Its presence cleanly gates the whole server-preference
      // path (C-ABI symbol ships in the same build): old addons fall back to
      // the pure-TS engine below, new addons use C-ABI → napi.
      const hasServerPreference = typeof inst.negotiateServerPreference === "function";
      return {
        negotiate(header) {
          if (header == null) return null;
          // C-ABI takes the header as a `cstring` ARG (engine transcodes
          // in-engine — zero JS encode); NAPI still needs bytes.
          if (inner && ffiInst) return ffiInst.acceptNegotiatorNegotiate(inner, header);
          return inst.negotiate(toBytes(header));
        },
        negotiateServerPreference(header) {
          if (header == null) return null;
          if (hasServerPreference) {
            if (inner && ffiInst) {
              // undefined = symbol absent (shouldn't happen when the napi
              // method exists, but never treat it as an answer) → napi fallback.
              const v = ffiInst.acceptNegotiatorNegotiateServer(inner, header);
              if (v !== undefined) return v;
            }
            return inst.negotiateServerPreference(toBytes(header));
          }
          return negotiateServerPreferenceJs(header, supported);
        },
      };
    } catch {
      // native compile failure → fall back to the pure-TS engine
    }
  }
  return createAcceptNegotiatorFallback(supported);
};

/**
 * Pure-TS server-preference negotiation (the `negotiateEncoding` semantic):
 * explicit q-values with a wildcard fallback for unlisted encodings, `q <= 0`
 * excluded, ties resolved by the supported list's order (server preference).
 * Empty/absent header → `null` (identity). Shared by the native-absent paths.
 */
export const negotiateServerPreferenceJs = (
  header: string | null,
  supported: readonly string[],
): string | null => {
  if (!header) return null;
  const prefs = parseAcceptEncodingFallback(header);
  if (prefs.length === 0) return null;
  const explicit = new Map<string, number>();
  let wildcardQ = -1;
  for (const { encoding, q } of prefs) {
    if (encoding === "*") {
      wildcardQ = Math.max(wildcardQ, q);
      continue;
    }
    // First occurrence wins (RFC 7231 duplicates are undefined).
    if (!explicit.has(encoding)) explicit.set(encoding, q);
  }
  let best: string | null = null;
  let bestQ = -1;
  for (const enc of supported) {
    const q = explicit.has(enc) ? (explicit.get(enc) as number) : wildcardQ >= 0 ? wildcardQ : -1;
    if (q <= 0) continue;
    // Ties keep the earlier `supported` entry (server preference).
    if (q > bestQ) {
      best = enc;
      bestQ = q;
    }
  }
  return best;
};

/** Pure-TS fallback for {@link createAcceptNegotiator} (identical behavior). */
interface NegotiationCandidate {
  enc: string;
  q: number;
  spec: number;
  order: number;
}

/** Best client preference for a single supported value (specificity → order). */
const matchSupported = (
  supported: string,
  prefs: EncodingPrefResult[],
): NegotiationCandidate | null => {
  let matched: { q: number; spec: number; order: number } | null = null;
  for (const pref of prefs) {
    const spec = pref.encoding === supported ? 2 : pref.encoding === "*" ? 1 : -1;
    if (spec < 0) continue;
    if (
      matched === null ||
      spec > matched.spec ||
      (spec === matched.spec && pref.order < matched.order)
    ) {
      matched = { q: pref.q, spec, order: pref.order };
    }
  }
  if (matched === null || matched.q <= 0) return null;
  return { enc: supported, q: matched.q, spec: matched.spec, order: matched.order };
};

/** RFC 7231 §5.3.4 ordering: specificity, then q-value, then client order. */
const isBetter = (cand: NegotiationCandidate, best: NegotiationCandidate): boolean =>
  cand.spec > best.spec ||
  (cand.spec === best.spec && Math.abs(cand.q - best.q) > 1e-4 && cand.q > best.q) ||
  (cand.spec === best.spec && Math.abs(cand.q - best.q) <= 1e-4 && cand.order < best.order);

/**
 * Pure-JS fallback for `Accept-Encoding` negotiation — used when the native
 * addon is unavailable. Returns the best supported encoding or `null`.
 */
export const createAcceptNegotiatorFallback = (supported: string[]): AcceptNegotiator => {
  const normalized = supported.map((s) => s.toLowerCase());
  return {
    negotiate(header) {
      const prefs = parseAcceptEncodingFallback(header ?? "");
      if (prefs.length === 0) return normalized[0] ?? null;
      let best: NegotiationCandidate | null = null;
      for (const sup of normalized) {
        const cand = matchSupported(sup, prefs);
        if (cand && (best === null || isBetter(cand, best))) best = cand;
      }
      return best ? best.enc : null;
    },
    negotiateServerPreference(header) {
      return negotiateServerPreferenceJs(header, normalized);
    },
  };
};
