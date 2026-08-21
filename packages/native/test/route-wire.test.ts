/**
 * Wire-codec tests for the per-route native stack (`route-wire.ts`).
 *
 * Locks the binary contract between @ignex/native and the Rust addon
 * (rust/ingress/native_route.rs): descriptor encode/decode round-trip, frame
 * packing, and
 * result decoding must be stable and self-consistent — changing one side
 * alone breaks parity, which these tests guard against.
 */
import {
  decodeRouteDescriptor,
  encodeRouteDescriptor,
  type NativeRouteFrame,
  type NativeRoutePlan,
  packRouteFrame,
  packRouteFrameInto,
  packRouteFrameLength,
  ROUTE_DESC_MAGIC,
  ROUTE_DESC_VERSION,
  ROUTE_STAGE_TAG,
  readRouteResult,
} from "@ignex/native";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();
const schema = (json: string): Uint8Array => enc.encode(json);

const bodySchema = schema('{"type":"object","properties":{"name":{"type":"string"}}}');
const querySchema = schema('{"type":"object","properties":{"q":{"type":"string"}}}');

const plan = (over: Partial<NativeRoutePlan> = {}): NativeRoutePlan => ({
  pipeline: ["parseQuery", "parseCookies", "requireJsonBody"],
  schemas: { body: bodySchema, query: querySchema },
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 1024,
  maxCookieBytes: 4096,
  maxPairs: 100,
  ...over,
});

describe("route descriptor wire", () => {
  it("round-trips pipeline, limits and schemas", () => {
    const decoded = decodeRouteDescriptor(encodeRouteDescriptor(plan()));
    expect(decoded.version).toBe(ROUTE_DESC_VERSION);
    expect(decoded.pipeline).toEqual(["parseQuery", "parseCookies", "requireJsonBody"]);
    expect(decoded.maxBodyBytes).toBe(2 * 1024 * 1024);
    expect(decoded.maxQueryBytes).toBe(1024);
    expect(decoded.maxCookieBytes).toBe(4096);
    expect(decoded.maxPairs).toBe(100);
    expect(decoded.schemas.body).toEqual(bodySchema);
    expect(decoded.schemas.query).toEqual(querySchema);
  });

  it("omits absent schemas and pipeline stages", () => {
    const decoded = decodeRouteDescriptor(
      encodeRouteDescriptor(
        plan({
          pipeline: [],
          schemas: {},
        }),
      ),
    );
    expect(decoded.pipeline).toEqual([]);
    expect(Object.keys(decoded.schemas)).toHaveLength(0);
  });

  it("rejects a bad magic", () => {
    const buf = encodeRouteDescriptor(plan());
    buf[0] = 0x00; // corrupt magic
    expect(() => decodeRouteDescriptor(buf)).toThrow(/bad magic/);
  });

  it("rejects an unsupported version", () => {
    const buf = encodeRouteDescriptor(plan());
    // version lives at offset 4
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(
      4,
      ROUTE_DESC_VERSION + 1,
      true,
    );
    expect(() => decodeRouteDescriptor(buf)).toThrow(/unsupported version/);
  });

  it("descriptor starts with the ROUT magic", () => {
    const buf = encodeRouteDescriptor(plan());
    expect(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true)).toBe(
      ROUTE_DESC_MAGIC,
    );
  });
});

describe("route request frame wire", () => {
  const frame: NativeRouteFrame = {
    query: "a=1&b=hello%20world",
    cookie: "sid=abc123; theme=dark",
    body: enc.encode('{"name":"x"}'),
  };

  it("packRouteFrameInto matches packRouteFrame bytes", () => {
    const packed = packRouteFrame(frame);
    const into = new Uint8Array(packRouteFrameLength(frame));
    packRouteFrameInto(into, frame);
    expect(packed).toEqual(into);
  });

  it("sizes the frame exactly (no trailing bytes)", () => {
    const packed = packRouteFrame(frame);
    expect(packed.byteLength).toBe(packRouteFrameLength(frame));
  });

  it("marks hasBody and writes body bytes last", () => {
    const packed = packRouteFrame(frame);
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    expect(view.getUint32(0, true)).toBe(1); // hasBody
    // decode: flags(4) + query len(4) + query + cookie len(4) + cookie + body len(4) + body
    let pos = 4;
    const qLen = view.getUint32(pos, true);
    pos += 4 + qLen;
    const cLen = view.getUint32(pos, true);
    pos += 4 + cLen;
    const bLen = view.getUint32(pos, true);
    pos += 4;
    expect(bLen).toBe(frame.body?.byteLength);
    expect(packed.subarray(pos, pos + bLen)).toEqual(frame.body);
  });

  it("empty body → hasBody flag 0 and no body section", () => {
    const packed = packRouteFrame({ query: "a=1", cookie: "", body: null });
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    expect(view.getUint32(0, true)).toBe(0);
    // flags(4) + query(4+3) + cookie(4+0) = 15
    expect(packed.byteLength).toBe(4 + 4 + 3 + 4);
  });
});

describe("route result wire", () => {
  // Build a result wire by hand: flags(ok | queryValid | cookieValid), error 0,
  // query pairs [a=1], cookie pairs [theme=dark].
  const buildResult = (): Uint8Array => {
    const query = [["a", "1"]] as const;
    const cookie = [["theme", "dark"]] as const;
    const pairsLen = (pairs: ReadonlyArray<readonly [string, string]>): number =>
      4 + pairs.reduce((n, [k, v]) => n + 4 + k.length + 4 + v.length, 0);
    const total = 8 + pairsLen(query) + pairsLen(cookie);
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    let flags = 1; // ok
    flags |= 1 << 2; // queryValid
    flags |= 1 << 3; // cookieValid
    view.setUint32(0, flags, true);
    view.setUint32(4, 0, true);
    let pos = 8;
    const writePairs = (pairs: ReadonlyArray<readonly [string, string]>): void => {
      view.setUint32(pos, pairs.length, true);
      pos += 4;
      for (const [k, v] of pairs) {
        view.setUint32(pos, k.length, true);
        pos += 4;
        buf.set(enc.encode(k), pos);
        pos += k.length;
        view.setUint32(pos, v.length, true);
        pos += 4;
        buf.set(enc.encode(v), pos);
        pos += v.length;
      }
    };
    writePairs(query);
    writePairs(cookie);
    return buf;
  };

  it("decodes flags, error code and both pair lists", () => {
    const r = readRouteResult(buildResult());
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBe(0);
    expect(r.queryValid).toBe(true);
    expect(r.cookieValid).toBe(true);
    expect(r.bodyValidJson).toBe(false);
    expect(r.bodyValid).toBe(false);
    expect(r.paramsValid).toBe(false);
    expect(r.headersValid).toBe(false);
    expect(r.query).toEqual([["a", "1"]]);
    expect(r.cookie).toEqual([["theme", "dark"]]);
  });

  it("decodes an error result (ok=0, errorCode set, empty pairs)", () => {
    const buf = new Uint8Array(8 + 4 + 4); // flags + error + empty query + empty cookie
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0, true); // !ok
    view.setUint32(4, 400, true); // errorCode
    view.setUint32(8, 0, true); // query count 0
    view.setUint32(12, 0, true); // cookie count 0
    const r = readRouteResult(buf);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(400);
    expect(r.query).toEqual([]);
    expect(r.cookie).toEqual([]);
  });

  it("stage tags match the wire values", () => {
    expect(ROUTE_STAGE_TAG.parseQuery).toBe(0);
    expect(ROUTE_STAGE_TAG.parseCookies).toBe(1);
    expect(ROUTE_STAGE_TAG.validateQuery).toBe(2);
    expect(ROUTE_STAGE_TAG.validateCookies).toBe(3);
    expect(ROUTE_STAGE_TAG.validateBody).toBe(4);
    expect(ROUTE_STAGE_TAG.requireJsonBody).toBe(5);
  });
});
