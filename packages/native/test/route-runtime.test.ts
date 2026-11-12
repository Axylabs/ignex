import { describe, expect, it } from "vitest";
import { createNativeRouteRuntime } from "../src/route";
import {
  type NativeRoutePlan,
  ROUTE_RESULT_FLAG_BODY_VALID,
  ROUTE_RESULT_FLAG_BODY_VALID_JSON,
  ROUTE_RESULT_FLAG_COOKIE_VALID,
  ROUTE_RESULT_FLAG_OK,
  ROUTE_RESULT_FLAG_QUERY_VALID,
} from "../src/route-wire";

const encoder = new TextEncoder();
const ALL_VALID =
  ROUTE_RESULT_FLAG_OK |
  ROUTE_RESULT_FLAG_BODY_VALID_JSON |
  ROUTE_RESULT_FLAG_BODY_VALID |
  ROUTE_RESULT_FLAG_QUERY_VALID |
  ROUTE_RESULT_FLAG_COOKIE_VALID;

const plan: NativeRoutePlan = {
  pipeline: ["parseQuery", "parseCookies", "requireJsonBody", "validateBody"],
  schemas: {},
  maxBodyBytes: 1024,
  maxQueryBytes: 1024,
  maxCookieBytes: 1024,
  maxPairs: 0,
};

type Pairs = ReadonlyArray<readonly [string, string]>;

const writeResult = (out: Uint8Array, query: Pairs, cookie: Pairs): number => {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, ALL_VALID, true);
  view.setUint32(4, 0, true);
  let pos = 8;
  for (const pairs of [query, cookie]) {
    view.setUint32(pos, pairs.length, true);
    pos += 4;
    for (const [name, value] of pairs) {
      const nameBytes = encoder.encode(name);
      const valueBytes = encoder.encode(value);
      view.setUint32(pos, nameBytes.byteLength, true);
      pos += 4;
      out.set(nameBytes, pos);
      pos += nameBytes.byteLength;
      view.setUint32(pos, valueBytes.byteLength, true);
      pos += 4;
      out.set(valueBytes, pos);
      pos += valueBytes.byteLength;
    }
  }
  return pos;
};

describe("compiled native route runtime", () => {
  it("does one direct crossing per request and decodes only the route result", () => {
    let directCalls = 0;
    let frameCalls = 0;
    let destroyCalls = 0;
    const seenBodies: string[] = [];
    const route = createNativeRouteRuntime(
      {
        run(_frame, out) {
          frameCalls++;
          return writeResult(out, [], []);
        },
        runParts(query, cookie, body, out) {
          directCalls++;
          seenBodies.push(new TextDecoder().decode(body ?? undefined));
          expect(query).toMatch(/^page=\d+$/);
          expect(cookie).toBe("sid=abc");
          return writeResult(out, [["page", query.slice(5)]], [["sid", cookie.slice(4)]]);
        },
        destroy() {
          destroyCalls++;
        },
      },
      plan,
    );

    const first = route.runParts("page=2", "sid=abc", encoder.encode('{"x":1}'));
    expect(first).toMatchObject({
      ok: true,
      errorCode: 0,
      bodyValidJson: true,
      bodyValid: true,
      queryValid: true,
      cookieValid: true,
      query: [["page", "2"]],
      cookie: [["sid", "abc"]],
    });
    const second = route.runParts("page=3", "sid=abc", encoder.encode('{"x":2}'));
    expect(second.query).toEqual([["page", "3"]]);
    expect(directCalls).toBe(2);
    expect(frameCalls).toBe(0);
    expect(seenBodies).toEqual(['{"x":1}', '{"x":2}']);
    route.destroy();
    expect(destroyCalls).toBe(1);
  });

  it("retries once at the exact required output size", () => {
    const pairs = Array.from({ length: 32 }, (_, i) => [`key${i}`, `value${i}`] as const);
    const required = writeResult(new Uint8Array(4096), pairs, []);
    let calls = 0;
    const route = createNativeRouteRuntime(
      {
        run() {
          throw new Error("frame path must not run");
        },
        runParts(_query, _cookie, _body, out) {
          calls++;
          if (out.byteLength < required) return required;
          return writeResult(out, pairs, []);
        },
        destroy() {},
      },
      plan,
    );

    const result = route.runParts("large=query", "", null);
    expect(calls).toBe(2);
    expect(result.query).toHaveLength(32);
    expect(result.query[31]).toEqual(["key31", "value31"]);
    route.destroy();
  });

  it("uses one packed-frame call for embedded-NUL parity", () => {
    let directCalls = 0;
    let frameCalls = 0;
    const route = createNativeRouteRuntime(
      {
        run(_frame, out) {
          frameCalls++;
          return writeResult(out, [["a", "before\0after"]], []);
        },
        runParts() {
          directCalls++;
          throw new Error("direct cstring input must not receive NUL");
        },
        destroy() {},
      },
      plan,
    );

    const result = route.runParts("a=before\0after", "", null);
    expect(result.query).toEqual([["a", "before\0after"]]);
    expect(directCalls).toBe(0);
    expect(frameCalls).toBe(1);
    route.destroy();
  });

  it("destroys the native handle once and rejects use after destroy", () => {
    let destroyCalls = 0;
    let runCalls = 0;
    const route = createNativeRouteRuntime(
      {
        run() {
          runCalls++;
          return 0;
        },
        destroy() {
          destroyCalls++;
        },
      },
      plan,
    );

    route.destroy();
    route.destroy();
    expect(destroyCalls).toBe(1);
    expect(() => route.runParts("a=1", "", null)).toThrow("already destroyed");
    expect(runCalls).toBe(0);
  });
});
