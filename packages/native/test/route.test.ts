/**
 * End-to-end parity tests for the per-route native stack
 * (`createNativeRoute` + the `castrum_route_*` C-ABI surface).
 *
 * When a castrum build ships the route surface (local dev build with the
 * route module; the registry `^0.9.0` does NOT), these prove the pre-baked
 * native instance parses query/cookies byte-identically to the JS wrappers —
 * including the lenient malformed-`%XX` and invalid-UTF-8 cases where the
 * strict castrum scalar parsers differ. Skipped when the addon lacks the
 * surface (the JS prelude remains the fallback).
 */
import { cookiePairs, createNativeRoute, type NativeRoutePlan, queryPairs } from "@ignex/native";
import { describe, expect, it } from "vitest";

const plan = (over: Partial<NativeRoutePlan> = {}): NativeRoutePlan => ({
  pipeline: ["parseQuery", "parseCookies"],
  schemas: {},
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
  ...over,
});

const available = createNativeRoute(plan()) !== null;

describe("per-route native stack (createNativeRoute)", () => {
  it("never throws — graceful null (JS prelude remains the fallback)", () => {
    let route: ReturnType<typeof createNativeRoute>;
    expect(() => {
      route = createNativeRoute(plan());
    }).not.toThrow();
    expect(route === null || typeof route.run === "function").toBe(true);
    route?.destroy();
  });

  it.skipIf(!available)("parses query byte-identically to the JS wrapper", () => {
    const route = createNativeRoute(plan());
    expect(route).not.toBeNull();
    if (!route) return;

    const cases = [
      "a=1&b=hello%20world&c=2",
      "m=%ZZ&n=abc%", // malformed → lenient raw (JS parity)
      "u=%E2%9C%93", // UTF-8 ✓
      "p=a+b", // + → space
      "k=%2B", // %2B → literal +
      "k&k2=", // empty value
      "q=%FF", // invalid UTF-8 → raw (JS parity)
    ];
    for (const qs of cases) {
      const r = route.run({ query: qs, cookie: "", body: null });
      expect(r.ok).toBe(true);
      expect(r.query).toEqual(queryPairs(qs));
    }
    route.destroy();
  });

  it.skipIf(!available)("parses cookies byte-identically to the JS wrapper", () => {
    const route = createNativeRoute(plan());
    expect(route).not.toBeNull();
    if (!route) return;

    const cases = ["sid=abc; theme=dark", 'a=1; "quoted"=val;  spaced = x ', "empty=; bare"];
    for (const cs of cases) {
      const r = route.run({ query: "", cookie: cs, body: null });
      expect(r.ok).toBe(true);
      expect(r.cookie).toEqual(cookiePairs(cs));
    }
    route.destroy();
  });

  it.skipIf(!available)("returns ok flags and empty pairs for an absent part", () => {
    // ParseQuery-only plan: the cookie section is absent from the result wire,
    // so `r.cookie` decodes to `[]` even though the frame carries a cookie.
    // NOTE: `plan()` merges `pipeline` verbatim — `parseQuery`/`parseCookies`
    // are NOT `NativeRoutePlan` fields, so pass `pipeline` directly.
    const route = createNativeRoute(plan({ pipeline: ["parseQuery"] }));
    expect(route).not.toBeNull();
    if (!route) return;
    const r = route.run({ query: "x=1", cookie: "s=v", body: null });
    expect(r.ok).toBe(true);
    expect(r.query).toEqual([["x", "1"]]);
    expect(r.cookie).toEqual([]);
    route.destroy();
  });

  it.skipIf(!available)("runParts(query, cookie, body) matches run(frame) byte-for-byte", () => {
    // Synced from castrum's `native-route.ts` convenience shape: the compiled
    // handlers' hot path packs from raw inputs (no frame object) — the decoded
    // result must be identical to the frame-based `run`.
    const route = createNativeRoute(plan());
    expect(route).not.toBeNull();
    if (!route) return;

    expect(route.parseQuery).toBe(true);
    expect(route.parseCookies).toBe(true);

    const cases: Array<[string, string]> = [
      ["a=1&b=hello%20world", "sid=abc; theme=dark"],
      ["m=%ZZ&n=abc%", ""],
      ["", 'a=1; "quoted"=val'],
    ];
    for (const [qs, cs] of cases) {
      const viaFrame = route.run({ query: qs, cookie: cs, body: null });
      const viaParts = route.runParts(qs, cs, null);
      expect(viaParts.ok).toBe(viaFrame.ok);
      expect(viaParts.query).toEqual(viaFrame.query);
      expect(viaParts.cookie).toEqual(viaFrame.cookie);
    }
    route.destroy();
  });

  it.skipIf(!available)("exposes parseQuery/parseCookies from the compiled plan", () => {
    const qOnly = createNativeRoute(plan({ pipeline: ["parseQuery"] }));
    expect(qOnly).not.toBeNull();
    if (!qOnly) return;
    expect(qOnly.parseQuery).toBe(true);
    expect(qOnly.parseCookies).toBe(false);
    qOnly.destroy();
  });

  it.skipIf(!available)("validates the raw body bytes (bytes-in / verdict-out)", () => {
    // Phase-2 stack: requireJsonBody (400) + validateBody (422) on raw bytes.
    const route = createNativeRoute(
      plan({
        pipeline: ["requireJsonBody", "validateBody"],
        schemas: {
          body: new TextEncoder().encode(
            JSON.stringify({
              type: "object",
              required: ["x"],
              properties: { x: { type: "number" } },
            }),
          ),
        },
      }),
    );
    expect(route).not.toBeNull();
    if (!route) return;

    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

    const ok = route.run({ query: "", cookie: "", body: enc('{"x":1}') });
    expect(ok.ok).toBe(true);
    expect(ok.errorCode).toBe(0);
    expect(ok.bodyValidJson).toBe(true);
    expect(ok.bodyValid).toBe(true);

    const badJson = route.run({ query: "", cookie: "", body: enc("not json") });
    expect(badJson.ok).toBe(false);
    expect(badJson.errorCode).toBe(400);
    expect(badJson.bodyValidJson).toBe(false);

    const schemaFail = route.run({ query: "", cookie: "", body: enc('{"x":"str"}') });
    expect(schemaFail.ok).toBe(false);
    expect(schemaFail.errorCode).toBe(422);
    expect(schemaFail.bodyValidJson).toBe(true); // JSON was fine — schema failed
    expect(schemaFail.bodyValid).toBe(false);

    route.destroy();
  });
});
