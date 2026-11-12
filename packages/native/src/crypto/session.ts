/**
 * @fileoverview Fused session envelope — `{"id":"…","data":<dataJson>,"exp":exp}`
 * signed into the `payload.<hex>` cookie token in ONE C-ABI crossing through
 * castrum's shared, self-tested native bridge. Full bounds validation remains
 * on the open wire; the JS path owns sessions when FFI is unavailable.
 * Re-exported by `./index`.
 */

import { getNativeBridge } from "../loader";
import { decoder } from "../util";

// ── Session envelope (fused JSON + HMAC) ────────────────────────────

interface SessionFfi {
  seal(id: string, dataJson: string, exp: number, secret: string): string | null;
  open(token: string, secret: string, out: Uint8Array, outLen: number): number;
}

let sessionFfi: SessionFfi | null | undefined;

const getSessionFfi = (): SessionFfi | null => {
  if (sessionFfi !== undefined) return sessionFfi;
  sessionFfi = null;
  const ffi = getNativeBridge()?.getFfi();
  if (!ffi) return null;
  sessionFfi = {
    seal: (id, dataJson, exp, secret) => ffi.sessionSeal(id, dataJson, exp, secret),
    open: (token, secret, out) => ffi.sessionOpen(token, secret, out),
  };
  return sessionFfi;
};

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
