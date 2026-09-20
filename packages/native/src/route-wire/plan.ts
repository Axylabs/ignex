/**
 * @fileoverview Route-descriptor codec — the compile-time wire the compiler
 * emits once per eligible route and the Rust addon pre-bakes into a per-route
 * instance (`encodeRouteDescriptor` / `decodeRouteDescriptor` with hard magic
 * + version validation).
 *
 * Extracted from the pre-split `route-wire.ts` (move-only); owns the shared
 * `dv` (little-endian DataView) helper that the frame codec also imports.
 */

import type { RoutePartKind } from "./constants";
import { PART_TAG, ROUTE_DESC_MAGIC, ROUTE_DESC_VERSION, TAG_PART } from "./constants";
import type { NativeRouteStage } from "./stages";
import { ROUTE_STAGE_TAG, TAG_STAGE } from "./stages";

/**
 * Everything a route's native stack pre-bakes: the exact ordered `pipeline`
 * (which features run, and in what order — the compiler enables only what the
 * route needs), the draft-07 JSON schemas for validated parts (compiled once
 * at construction, so there is no per-request schema work), and the limits.
 */
export interface NativeRoutePlan {
  /** The exact ordered pipeline the instance follows (features on, in order). */
  readonly pipeline: readonly NativeRouteStage[];
  /** Draft-07 JSON schema bytes per validated part (query/cookie/body/…). */
  readonly schemas: Readonly<Partial<Record<RoutePartKind, Uint8Array>>>;
  readonly maxBodyBytes: number;
  readonly maxQueryBytes: number;
  readonly maxCookieBytes: number;
  readonly maxPairs: number;
}

/** True when the plan's pipeline includes `stage`. */
export const planHasStage = (plan: NativeRoutePlan, stage: NativeRouteStage): boolean =>
  plan.pipeline.includes(stage);

/** Little-endian DataView over a byte buffer (shared wire read/write helper). */
export const dv = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Encode a route plan into the descriptor wire. The compiler emits this once
 * per eligible route; Rust compiles it into a pre-baked instance.
 *
 * Wire: `[magic][version][maxBody][maxQuery][maxCookie][maxPairs]
 * [stageCount]{[u8 stage]}[schemaCount]{[u8 part][u32 len][schema]}`.
 */
export const encodeRouteDescriptor = (plan: NativeRoutePlan): Uint8Array => {
  const kinds = Object.keys(plan.schemas) as RoutePartKind[];
  // header: magic, version, 4 limits, stageCount, schemaCount
  let total = 4 + 4 + 4 * 4 + 4 + 4;
  total += plan.pipeline.length; // 1 byte per stage
  for (const k of kinds) total += 1 + 4 + ((plan.schemas[k]?.byteLength ?? 0) as number);

  const out = new Uint8Array(total);
  const view = dv(out);
  let pos = 0;
  view.setUint32(pos, ROUTE_DESC_MAGIC, true);
  pos += 4;
  view.setUint32(pos, ROUTE_DESC_VERSION, true);
  pos += 4;
  view.setUint32(pos, plan.maxBodyBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxQueryBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxCookieBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxPairs, true);
  pos += 4;
  view.setUint32(pos, plan.pipeline.length, true);
  pos += 4;
  for (const stage of plan.pipeline) {
    out[pos] = ROUTE_STAGE_TAG[stage];
    pos += 1;
  }
  view.setUint32(pos, kinds.length, true);
  pos += 4;
  for (const k of kinds) {
    const schema = plan.schemas[k] as Uint8Array;
    out[pos] = PART_TAG[k];
    pos += 1;
    view.setUint32(pos, schema.byteLength, true);
    pos += 4;
    out.set(schema, pos);
    pos += schema.byteLength;
  }
  return out;
};

/** The descriptor wire as decoded (validated magic/version) by {@link decodeRouteDescriptor}. */
export interface DecodedRouteDescriptor extends NativeRoutePlan {
  readonly version: number;
}

/**
 * Decode + validate a route descriptor wire. Throws on a bad magic or a
 * version the current codec cannot parse — a mismatched compiler/addon is a
 * hard error, never a silent misparse.
 */
export const decodeRouteDescriptor = (buf: Uint8Array): DecodedRouteDescriptor => {
  const view = dv(buf);
  const magic = view.getUint32(0, true);
  if (magic !== ROUTE_DESC_MAGIC) {
    throw new Error(`route descriptor: bad magic 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== ROUTE_DESC_VERSION) {
    throw new Error(
      `route descriptor: unsupported version ${version} (this build supports ${ROUTE_DESC_VERSION})`,
    );
  }
  let pos = 8;
  const maxBodyBytes = view.getUint32(pos, true);
  pos += 4;
  const maxQueryBytes = view.getUint32(pos, true);
  pos += 4;
  const maxCookieBytes = view.getUint32(pos, true);
  pos += 4;
  const maxPairs = view.getUint32(pos, true);
  pos += 4;

  const stageCount = view.getUint32(pos, true);
  pos += 4;
  const pipeline: NativeRouteStage[] = [];
  for (let i = 0; i < stageCount; i++) {
    const tag = buf[pos] as number;
    pos += 1;
    const stage = TAG_STAGE[tag];
    if (stage === undefined) throw new Error(`route descriptor: unknown stage tag ${tag}`);
    pipeline.push(stage);
  }

  const schemaCount = view.getUint32(pos, true);
  pos += 4;
  const schemas: Partial<Record<RoutePartKind, Uint8Array>> = {};
  for (let i = 0; i < schemaCount; i++) {
    const tag = buf[pos] as number;
    pos += 1;
    const kind = TAG_PART[tag];
    if (kind === undefined) throw new Error(`route descriptor: unknown part tag ${tag}`);
    const len = view.getUint32(pos, true);
    pos += 4;
    schemas[kind] = buf.subarray(pos, pos + len);
    pos += len;
  }

  return {
    version,
    pipeline,
    schemas,
    maxBodyBytes,
    maxQueryBytes,
    maxCookieBytes,
    maxPairs,
  };
};
