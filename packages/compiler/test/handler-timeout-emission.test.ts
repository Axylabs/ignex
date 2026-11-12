/**
 * Handler-timeout emission — the compiler bakes `__HANDLER_TIMEOUT_MS` and
 * the `__raceHandler` race helper into the artifact when the option is set;
 * wrappers route async handler results through the race.
 */
import { describe, expect, it } from "vitest";
import { HELPER_SOURCES } from "../src/phases/codegen/helpers";

describe("handler timeout emission", () => {
  it("emits the race helper with the stable code/reason markers", () => {
    const src = HELPER_SOURCES.__raceHandler;
    expect(src).toContain("__HANDLER_TIMEOUT_MS");
    expect(src).toContain("HANDLER_TIMEOUT_CODE");
    expect(src).toContain("x-ignex-reason");
    expect(src).toContain("Promise.race");
    // Off-guard: no cap → plain error funnel, zero added per-request cost.
    expect(src).toContain("if (!__HANDLER_TIMEOUT_MS) return promise.catch(onError)");
  });

  it("bakes one 503 template and clones its unread body per timeout", () => {
    const src = HELPER_SOURCES.__raceHandler;
    expect(src).toContain("const __TIMEOUT_BODY = JSON.stringify(");
    expect(src).toContain("const __TIMEOUT_RESPONSE = new Response(__TIMEOUT_BODY");
    expect(src).toContain("resolve(__TIMEOUT_RESPONSE.clone())");
    expect(src).not.toContain("new Response(JSON.stringify(");
  });

  it("wrappers route async results through the race helper", () => {
    expect(HELPER_SOURCES.__wrapStatic).toContain("__raceHandler(r, onError)");
    expect(HELPER_SOURCES.__wrap).toContain("__raceHandler(__r, onError)");
    // The statically-sync wrapper deliberately does NOT race (it cannot
    // resume asynchronously by contract).
    expect(HELPER_SOURCES.__wrapStaticSync).not.toContain("__raceHandler");
  });
});
