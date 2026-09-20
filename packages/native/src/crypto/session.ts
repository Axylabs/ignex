/**
 * @fileoverview Fused session envelope — `{"id":"…","data":<dataJson>,"exp":exp}`
 * signed into the `payload.<hex>` cookie token in ONE C-ABI crossing via a
 * lazy dlopen'd `castrum_session_seal`/`castrum_session_open` surface, with a
 * bind-time self-test and full bounds validation on the open wire; degrades to
 * the JS path (`signCookie`/`verifyCookie`) when ffi is unavailable.
 *
 * Extracted from the pre-split `crypto.ts` (move-only): this file keeps ALL
 * session module state (lazy `sessionFfi`, probe, self-test) private here.
 * Re-exported by `./index`.
 */

import { createRequire } from "node:module";
import { isFfiActive } from "../ffi";
import { getAddonPath } from "../loader";
import { reportDegradation } from "../telemetry";
import { decoder } from "../util";

// ── Session envelope (fused JSON + HMAC) ────────────────────────────

/** Lazy dedicated C-ABI surface for the two session symbols (null when absent). */
let sessionFfi:
  | {
      seal(id: string, dataJson: string, exp: number, secret: string): string | null;
      open(token: string, secret: string, out: Uint8Array, outLen: number): number;
    }
  | null
  | undefined;

const getSessionFfi = (): {
  seal(id: string, dataJson: string, exp: number, secret: string): string | null;
  open(token: string, secret: string, out: Uint8Array, outLen: number): number;
} | null => {
  if (sessionFfi !== undefined) return sessionFfi;
  sessionFfi = null;
  if (!isFfiActive()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require_ = createRequire(import.meta.url);
    const { dlopen } = require_("bun:ffi") as {
      dlopen: (
        p: string,
        syms: Record<string, { args: readonly string[]; returns: string }>,
      ) => { symbols: Record<string, (...a: unknown[]) => unknown> };
    };
    const addonPath = getAddonPath();
    if (!addonPath) return null;
    const { symbols } = dlopen(addonPath, {
      castrum_session_seal: {
        args: ["cstring", "cstring", "i64", "cstring"],
        returns: "cstring",
      },
      castrum_session_open: {
        args: ["cstring", "cstring", "ptr", "usize"],
        returns: "usize",
      },
    });
    if (
      typeof symbols.castrum_session_seal !== "function" ||
      typeof symbols.castrum_session_open !== "function"
    ) {
      return null;
    }
    const sealF = symbols.castrum_session_seal as (...a: unknown[]) => string | null;
    const openF = symbols.castrum_session_open as (...a: unknown[]) => number;
    // Bind-time round-trip self-test (the primary C-ABI surface has one; this
    // lazy surface previously had NONE — a broken bind or ABI drift would
    // surface as sessions that never validate at request time). Probe a fixed
    // envelope seal→open and require exact field recovery; any mismatch
    // degrades to the JS path (signCookie/verifyCookie) with a report.
    if (!sessionBindSelfTest(sealF, openF)) {
      reportDegradation(
        "self-test-failed",
        "sessionSeal",
        "session seal→open bind self-test failed — fused session ops disabled (JS path owns them)",
      );
      return null;
    }
    sessionFfi = {
      seal: (id, dataJson, exp, secret) => sealF(id, dataJson, BigInt(exp), secret),
      open: (token, secret, out, outLen) => Number(openF(token, secret, out, outLen)),
    };
    return sessionFfi;
  } catch {
    return null;
  }
};

/** Fixed probe payload for the session bind self-test. */
const SESSION_PROBE = {
  id: "__ignex_bind_probe__",
  dataJson: '{"v":1}',
  exp: 4_102_444_800,
} as const;
const SESSION_PROBE_SECRET = "__ignex_session_selftest_secret__";

/** Seal→open round-trip over the raw bound symbols; true iff fields recover exactly. */
function sessionBindSelfTest(
  sealF: (...a: unknown[]) => string | null,
  openF: (...a: unknown[]) => number,
): boolean {
  try {
    const token = sealF(
      SESSION_PROBE.id,
      SESSION_PROBE.dataJson,
      BigInt(SESSION_PROBE.exp),
      SESSION_PROBE_SECRET,
    );
    if (typeof token !== "string" || token.length === 0) return false;
    let out = new Uint8Array(512);
    let w = Number(openF(token, SESSION_PROBE_SECRET, out, out.length));
    if (w > out.length) {
      out = new Uint8Array(w);
      w = Number(openF(token, SESSION_PROBE_SECRET, out, out.length));
    }
    const decoded = decodeSessionWire(out, w);
    return (
      decoded !== null &&
      decoded.id === SESSION_PROBE.id &&
      decoded.exp === SESSION_PROBE.exp &&
      decoded.dataJson === SESSION_PROBE.dataJson
    );
  } catch {
    return false;
  }
}

/**
 * Decode the session-open wire (`[u8 ok][i64 exp][u32 idLen][id][u32
 * dataLen][data]`) under FULL bounds validation — every length is checked
 * against the written byte count before any subarray. Returns `null` on a
 * short/lying wire instead of decoding adjacent memory.
 */
function decodeSessionWire(
  out: Uint8Array,
  w: number,
): { id: string; exp: number; dataJson: string } | null {
  // Minimum wire: status(1) + exp(8) + idLen(4) + dataLen(4).
  if (w < 17 || out[0] !== 1 || w > out.byteLength) return null;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const exp = Number(dv.getBigInt64(1, true));
  const idLen = dv.getUint32(9, true);
  if (13 + idLen + 4 > w) return null;
  const id = decoder.decode(out.subarray(13, 13 + idLen));
  const dataLen = dv.getUint32(13 + idLen, true);
  const dataStart = 17 + idLen;
  if (dataLen > w - dataStart) return null;
  const dataJson = decoder.decode(out.subarray(dataStart, dataStart + dataLen));
  return { id, exp, dataJson };
}

/**
 * Fused session seal: builds `{"id":"…","data":<dataJson>,"exp":exp}` and
 * HMAC-signs it into the `payload.<hex>` cookie token in ONE crossing —
 * replaces `signCookie(JSON.stringify(envelope), secret)` (which paid a full
 * envelope stringify + a second transcode). `dataJson` is embedded verbatim.
 *
 * `id`, `dataJson` and `secret` cross the C ABI as `cstring` ARGs, which has
 * two consequences worth knowing:
 *
 * - They must be NUL-free. The engine transcode is NUL-terminated, so an
 *   embedded `U+0000` SILENTLY TRUNCATES the value before Rust sees it (an id
 *   carrying one would be sealed under its truncated form). Session ids and
 *   `JSON.stringify` output are NUL-free in practice — `JSON.stringify`
 *   escapes a NUL as `\u0000` — but an app passing a raw user string as `id`
 *   should reject `\u0000` itself.
 * - A `Uint8Array` `secret` is decoded as UTF-8 here, so a NON-UTF-8 key is
 *   reinterpreted (invalid sequences become `U+FFFD`). Seal and open decode
 *   identically, so a session round trip stays self-consistent; but mixing
 *   this API with a bytes-based `signCookie`/`verifyCookie` on the same
 *   non-UTF-8 key would not agree. Use a UTF-8 key, or the byte-exact native
 *   API directly.
 *
 * MEASURED (castrum 0.9.7 byte-arg siblings, through this call path, 200k
 * calls, ns/call): cstring 613.5; byte form pre-encoded 557.8 (−9.1%); byte
 * form encoding the args per call 620.6 (+1.2% SLOWER). This caller holds JS
 * strings, and encoding one short string costs ~45 ns — more than the ~56 ns
 * the engine's transcode costs — so the byte form is NOT adopted here. It pays
 * only for callers that already hold bytes (e.g. the ingress path).
 *
 * @returns The sealed token, or `null` when ffi is unavailable → callers use
 *   `signCookie(JSON.stringify(envelope), secret)`.
 */
export const sessionSeal = (
  id: string,
  dataJson: string,
  expSecs: number,
  secret: string | Uint8Array,
): string | null => {
  const ffiS = getSessionFfi();
  if (!ffiS) return null;
  const sStr = typeof secret === "string" ? secret : decoder.decode(secret);
  return ffiS.seal(id, dataJson, expSecs, sStr);
};

/**
 * Fused session open: verify + extract `{ id, exp, dataJson }` in one
 * crossing. `dataJson` is raw JSON text — parse in JS only when the caller
 * needs the object. `null` on bad signature / malformed / ffi unavailable.
 *
 * The wire is decoded under full bounds validation ({@link decodeSessionWire})
 * — a short or lying write returns `null`, never a decode of adjacent memory.
 *
 * `token` and `secret` cross as `cstring` ARGs: both must be NUL-free (an
 * embedded `U+0000` truncates before Rust sees it — a cookie value cannot
 * contain one, but a hand-built token could). A `Uint8Array` `secret` is
 * decoded as UTF-8, matching {@link sessionSeal}, so the round trip agrees on
 * a UTF-8 key; see that function for the measured reason the byte-arg
 * siblings are not used here.
 */
export const sessionOpen = (
  token: string,
  secret: string | Uint8Array,
): { id: string; exp: number; dataJson: string } | null => {
  const ffiS = getSessionFfi();
  if (!ffiS) return null;
  const sStr = typeof secret === "string" ? secret : decoder.decode(secret);
  let out = new Uint8Array(512);
  let w = ffiS.open(token, sStr, out, out.length);
  if (w > out.length) {
    out = new Uint8Array(w);
    w = ffiS.open(token, sStr, out, out.length);
  }
  if (w === 0) return null;
  return decodeSessionWire(out, w);
};
