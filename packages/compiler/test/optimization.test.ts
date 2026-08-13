/**
 * Hotness-driven optimization: the opt-in global inline budget prioritizes the
 * hottest routes, and constant-response dedup picks the hottest leader.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { applyInlineBudget, buildDedupMap } from "../src/phases/optimization";
import type { CompilerOptions, RouteIR } from "../src/types";
import { materializeFixture } from "./helpers";

const makeDef = (ref: string, hotness: number, body?: string): RouteIR =>
  ({
    analysis: { hotnessScore: hotness },
    decisions: {
      shouldInline: !!body,
      ...(body ? { inlineCandidate: { body, isAsync: false, param: "ctx" } } : {}),
    },
    codegen: { handlerRef: ref },
  }) as unknown as RouteIR;

describe("applyInlineBudget", () => {
  it("is a no-op when no budget is set (all candidates kept)", () => {
    const routes = [makeDef("a", 1, "aaa"), makeDef("b", 2, "bbb")];
    const out = applyInlineBudget(routes, {} as CompilerOptions);
    expect(out[0]?.decisions.inlineCandidate).toBeTruthy();
    expect(out[1]?.decisions.inlineCandidate).toBeTruthy();
  });

  it("prioritizes the hottest routes within the budget", () => {
    const routes = [makeDef("cold", 1, "x".repeat(100)), makeDef("hot", 9, "y".repeat(5))];
    const out = applyInlineBudget(routes, { maxTotalInlineBytes: 50 } as CompilerOptions);

    // The hot (5-byte) body fits; the cold (100-byte) body is de-inlined.
    expect(out[1]?.decisions.inlineCandidate).toBeTruthy();
    expect(out[0]?.decisions.inlineCandidate).toBeUndefined();
    expect(out[0]?.decisions.shouldInline).toBe(false);
  });

  it("de-inlines everything when the budget is smaller than every body", () => {
    const routes = [makeDef("a", 5, "hello"), makeDef("b", 1, "world")];
    const out = applyInlineBudget(routes, { maxTotalInlineBytes: 2 } as CompilerOptions);
    expect(out[0]?.decisions.inlineCandidate).toBeUndefined();
    expect(out[1]?.decisions.inlineCandidate).toBeUndefined();
  });

  it("keeps all candidates when the budget covers everything", () => {
    const routes = [makeDef("a", 1, "hello"), makeDef("b", 2, "world")];
    const out = applyInlineBudget(routes, { maxTotalInlineBytes: 100 } as CompilerOptions);
    expect(out[0]?.decisions.inlineCandidate).toBeTruthy();
    expect(out[1]?.decisions.inlineCandidate).toBeTruthy();
  });
});

describe("buildDedupMap", () => {
  it("picks the hottest route as the dedup leader", () => {
    const cold = makeDef("cold", 1);
    const hot = makeDef("hot", 5);
    const map = buildDedupMap(new Map([["GET:{}", [cold, hot]]]));
    expect(map.get("cold")).toBe("hot");
  });

  it("keeps the first route as leader on equal hotness", () => {
    const a = makeDef("a", 2);
    const b = makeDef("b", 2);
    const map = buildDedupMap(new Map([["GET:{}", [a, b]]]));
    expect(map.get("b")).toBe("a");
  });
});

describe("compile (inline budget)", () => {
  const options = (layout: ReturnType<typeof materializeFixture>, extra: object = {}) => ({
    routesDir: layout.routesDir,
    outDir: layout.outDir,
    outFile: "server.js",
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    ...extra,
  });

  it("inlines by default and de-inlines when the budget is tight", async () => {
    const defaultLayout = materializeFixture("basic");
    const defaultResult = await buildAsync(options(defaultLayout));
    expect(defaultResult.errors).toHaveLength(0);
    expect(defaultResult.code).toContain("Inlined route handler");

    const tightLayout = materializeFixture("basic");
    const tight = await buildAsync(options(tightLayout, { maxTotalInlineBytes: 1 }));
    expect(tight.errors).toHaveLength(0);
    expect(tight.code).not.toContain("Inlined route handler");
  });
});
