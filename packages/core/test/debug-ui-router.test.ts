/**
 * Hash router tests — the SPA's deep-linkable view state (needs a DOM
 * environment because the router binds `window.location.hash` at module load).
 */

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { currentRoute, navigate } from "../src/debug/ui/router";

const resetHash = (hash: string): void => {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
};

describe("debugbar hash router", () => {
  beforeEach(() => {
    resetHash("#/requests");
  });

  it("parses plain views and falls back to requests on unknown hashes", () => {
    navigate("metrics");
    expect(currentRoute()).toEqual({ view: "metrics", id: null, tab: null });
    resetHash("#/nope");
    expect(currentRoute()).toEqual({ view: "requests", id: null, tab: null });
  });

  it("parses request detail routes with an optional tab", () => {
    navigate("detail", "req 1", "waterfall");
    expect(currentRoute().view).toBe("detail");
    expect(currentRoute().id).toBe("req 1");
    expect(currentRoute().tab).toBe("waterfall");
    // No tab → defaults to null (the view falls back to "overview").
    navigate("detail", "req 2");
    expect(currentRoute()).toEqual({ view: "detail", id: "req 2", tab: null });
  });

  it("parses log detail routes", () => {
    navigate("logDetail", "7");
    expect(currentRoute()).toEqual({ view: "logDetail", id: "7", tab: null });
  });

  it("errors keeps its own canonical hash", () => {
    navigate("errors");
    expect(window.location.hash).toBe("#/errors");
    expect(currentRoute().view).toBe("errors");
  });
});
