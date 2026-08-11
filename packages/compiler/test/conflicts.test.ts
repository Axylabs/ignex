import { EMPTY_USAGE } from "@ignus/shared";
import { describe, expect, it } from "vitest";
import { DiagnosticCodes, DiagnosticCollector } from "../src/diagnostics";
import type { RouteIR } from "../src/ir/route";
import { detectRouteConflicts } from "../src/phases/analysis/conflicts";

const fakeRoute = (method: string, path: string, file: string): RouteIR => ({
  source: {
    method: method as RouteIR["source"]["method"],
    path,
    paramNames: [],
    isDynamic: false,
    isStatic: true,
    segmentCount: 1,
    file,
    moduleIdx: 0,
  },
  analysis: {
    isAsync: false,
    responseType: "json",
    hasValidation: false,
    hotnessScore: 0,
    hooks: [],
    isConstantResponse: false,
    usage: EMPTY_USAGE,
  },
  decisions: { shouldInline: false },
  codegen: { handlerRef: "_h0" },
});

/**
 * Error-contract tests: `detectRouteConflicts` reports error-level issues via
 * diagnostics (never a mid-pipeline throw), so the composed async pipeline can
 * surface a structured summary from its final `hasErrors` check.
 */
describe("detectRouteConflicts error contract", () => {
  it("reports duplicate routes as error diagnostics when strict (no throw)", () => {
    const d = new DiagnosticCollector();
    const routes = [fakeRoute("GET", "/a", "a.get.ts"), fakeRoute("GET", "/a", "b.get.ts")];

    expect(() =>
      detectRouteConflicts(routes, { strictRouteConflicts: true }, { diagnostics: d }),
    ).not.toThrow();

    expect(d.hasErrors).toBe(true);
    expect(d.errors[0]?.code).toBe(DiagnosticCodes.RouteConflict);
  });

  it("keeps duplicate routes non-fatal when strict is off", () => {
    const d = new DiagnosticCollector();
    const routes = [fakeRoute("GET", "/a", "a.get.ts"), fakeRoute("GET", "/a", "b.get.ts")];

    detectRouteConflicts(routes, { strictRouteConflicts: false }, { diagnostics: d });

    expect(d.hasErrors).toBe(false);
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.RouteConflict)).toBe(true);
  });
});
