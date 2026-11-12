/**
 * @fileoverview Opaque-handle instance adapter over castrum's shared bridge.
 * Native handles originate from the same addon as the C-ABI surface, so no
 * path comparison or second dlopen is necessary.
 */

import { getNativeBridge } from "../loader";
import { toBytes } from "../util";
import type { FfiInstancesSurface } from "./types";

let cached: FfiInstancesSurface | null | undefined;

/** Lazy access to the opaque-handle instance C-ABI surface. */
export const getFfiInstances = (): FfiInstancesSurface | null => {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.IGNEX_NATIVE === "off") return cached;

  const ffi = getNativeBridge()?.getFfi();
  if (!ffi) return cached;
  cached = {
    schemaQueryValidate: (inner, qs) => ffi.queryValidate(inner, qs),
    schemaCookieValidate: (inner, header) => ffi.cookieValidate(inner, header),
    schemaValidatorValidate: (inner, doc) => ffi.schemaValidatorValidate(inner, doc),
    templateRender: (inner, context, out) => ffi.templateRenderInto(inner, context, out),
    acceptNegotiatorNegotiate: (inner, header) =>
      ffi.acceptNegotiatorNegotiate(inner, toBytes(header)),
    acceptNegotiatorNegotiateServer: (inner, header) =>
      ffi.acceptNegotiatorNegotiateServerText(inner, header),
    conditionalIsNotModified: (inner, ifNoneMatch, ifModifiedSince) =>
      ffi.conditionalIsNotModified(
        inner,
        ifNoneMatch === null ? null : toBytes(ifNoneMatch),
        ifModifiedSince === null ? null : toBytes(ifModifiedSince),
      ),
  };
  return cached;
};
