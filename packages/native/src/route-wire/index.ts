/**
 * @fileoverview Per-route native stack — binary wire format (barrel).
 *
 * Re-exports the full pre-split `route-wire.ts` public surface (descriptor /
 * frame / result codecs + wire vocabulary) so existing `"./route-wire"`
 * imports resolve after the split (move-only).
 */

export type { RoutePartKind } from "./constants";
export {
  ROUTE_DESC_MAGIC,
  ROUTE_DESC_VERSION,
  ROUTE_FRAME_FLAG_HAS_BODY,
  ROUTE_RESULT_FLAG_BODY_VALID,
  ROUTE_RESULT_FLAG_BODY_VALID_JSON,
  ROUTE_RESULT_FLAG_COOKIE_VALID,
  ROUTE_RESULT_FLAG_HEADERS_VALID,
  ROUTE_RESULT_FLAG_OK,
  ROUTE_RESULT_FLAG_PARAMS_VALID,
  ROUTE_RESULT_FLAG_QUERY_VALID,
} from "./constants";
export type { NativeRouteFrame } from "./frame";
export {
  packRouteFrame,
  packRouteFrameInto,
  packRouteFrameLength,
  packRouteFramePartsInto,
  packRouteFramePartsLength,
  readRouteFrameLengths,
} from "./frame";
export type { DecodedRouteDescriptor, NativeRoutePlan } from "./plan";
export {
  decodeRouteDescriptor,
  encodeRouteDescriptor,
  planHasStage,
} from "./plan";
export type { NativeRouteRunResult } from "./result";
export { readRouteResult } from "./result";
export type { NativeRouteStage } from "./stages";
export { ROUTE_STAGE_TAG } from "./stages";
