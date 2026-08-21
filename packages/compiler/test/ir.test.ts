/**
 * Compiler IR + source-frontend tests.
 *
 * Covers the standard source layer (`SourceManager` / `SourceFile` — parse
 * once, retain the AST) and the Route IR (lowering, section ownership, and the
 * optimization decisions that land on `RouteIR.decisions`).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics";
import { SourceManager } from "../src/frontend";
import { lowerRoute, parseRouteFilename } from "../src/ir";
import type { RouteIR } from "../src/ir/route";
import { silentLogger } from "../src/logger";
import { runOptimization } from "../src/phases/optimization";
import { createDefaultOptions } from "../src/types";
import { clearParseCache } from "../src/utils/ast";

const makeSource = (sourceManager: SourceManager, rel: string, content: string) => {
  const source = sourceManager.fromSource(`/virtual/${rel}`, rel, content);
  if (!source) throw new Error(`failed to build source for ${rel}`);
  return source;
};

const mustParse = (file: string) => {
  const parsed = parseRouteFilename(file);
  if (!parsed) throw new Error(`failed to parse route filename ${file}`);
  return parsed;
};

const makeCtx = () => ({ logger: silentLogger, diagnostics: new DiagnosticCollector() });

describe("parseRouteFilename (file-based routing lowering)", () => {
  it("parses the method suffix", () => {
    expect(parseRouteFilename("echo.post.ts")?.method).toBe("POST");
    expect(parseRouteFilename("health.get.ts")?.method).toBe("GET");
    expect(parseRouteFilename("upload.post.ts")?.method).toBe("POST");
  });

  it("defaults to GET and drops an unrecognized last segment", () => {
    const parsed = parseRouteFilename("about.ts");
    expect(parsed?.method).toBe("GET");
    expect(parsed?.path).toBe("/about");
  });

  it("treats index as the directory root", () => {
    expect(parseRouteFilename("index.get.ts")?.path).toBe("/");
    // `/index` (6 chars incl. the leading slash) maps to the parent path —
    // NO trailing slash (`/api/index` → `/api`). A nested index must produce
    // the same static key as the bare parent route so `x.get.ts` +
    // `x/index.get.ts` are detected as exact duplicates.
    expect(parseRouteFilename("api/index.post.ts")?.path).toBe("/api");
    expect(parseRouteFilename("a/b/index.get.ts")?.path).toBe("/a/b");
  });

  it("decodes dynamic segments into :params and *wildcards", () => {
    const dynamic = parseRouteFilename("users/[id].get.ts");
    expect(dynamic?.path).toBe("/users/:id");
    expect(dynamic?.paramNames).toEqual(["id"]);
    expect(dynamic?.isDynamic).toBe(true);
    expect(dynamic?.isStatic).toBe(false);

    const rest = parseRouteFilename("files/[...path].get.ts");
    expect(rest?.path).toBe("/files/*path");
    expect(rest?.paramNames).toEqual(["path"]);
    expect(rest?.isDynamic).toBe(true);
  });

  it("computes the segment count", () => {
    expect(parseRouteFilename("a/b/c.get.ts")?.segmentCount).toBe(3);
    expect(parseRouteFilename("index.get.ts")?.segmentCount).toBe(0);
  });
});

describe("SourceManager (parse-once source layer)", () => {
  beforeEach(() => {
    clearParseCache();
  });

  it("retains the AST and extracted handler on the SourceFile", () => {
    const sm = new SourceManager();
    const source = makeSource(
      sm,
      "health.get.ts",
      `export default async (ctx) => {
  return { status: "ok" };
}`,
    );

    expect(source.ast.type).toBe("Program");
    expect(source.hasHandlerExport).toBe(true);
    expect(source.hasDefaultExport).toBe(true);
    expect(source.handler?.isAsync).toBe(true);
    expect(source.schemaExport).toBe(false);
  });

  it("fromSource is idempotent per path (same retained object)", () => {
    const sm = new SourceManager();
    const first = sm.fromSource("/virtual/a.ts", "a.ts", "export default () => 1;");
    const second = sm.fromSource("/virtual/a.ts", "a.ts", "export default () => 1;");
    expect(second).toBe(first);
    expect(sm.get("a.ts")).toBe(first);
    expect(sm.all()).toHaveLength(1);
  });

  it("clear() drops retained sources and the parse cache", () => {
    const sm = new SourceManager();
    sm.fromSource("/virtual/a.ts", "a.ts", "export default () => 1;");
    sm.clear();
    expect(sm.all()).toHaveLength(0);
    expect(sm.has("a.ts")).toBe(false);
  });

  it("detects named-export handlers and schema exports", () => {
    const sm = new SourceManager();
    const source = makeSource(
      sm,
      "echo.get.ts",
      `export const schema = {
  query: {
    type: "object",
    properties: { q: { type: "string" } },
  },
  response: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
};

export const httpGet = async (ctx) => ctx.json({ ok: true });
`,
    );

    expect(source.hasHandlerExport).toBe(true);
    expect(source.handlerExportName).toBe("httpGet");
    expect(source.schemaExport).toBe(true);
  });
});

describe("lowerRoute (source → RouteIR)", () => {
  it("builds the four owned IR sections from filename + AST", () => {
    const sm = new SourceManager();
    const source = makeSource(
      sm,
      "users/[id].get.ts",
      `export default async (ctx) => {
  return { id: ctx.params.id };
}`,
    );

    const ir = lowerRoute("users/[id].get.ts", mustParse("users/[id].get.ts"), source, 0, 0);

    // source: immutable filename facts
    expect(ir.source.method).toBe("GET");
    expect(ir.source.path).toBe("/users/:id");
    expect(ir.source.paramNames).toEqual(["id"]);
    expect(ir.source.isDynamic).toBe(true);
    expect(ir.source.moduleIdx).toBe(0);

    // analysis: AST-derived facts
    expect(ir.analysis.isAsync).toBe(true);
    expect(ir.analysis.isConstantResponse).toBe(false);
    expect(ir.analysis.hasValidation).toBe(false);

    // decisions: optimization-owned, initially empty
    expect(ir.decisions.shouldInline).toBe(false);

    // codegen: identifier assigned at lowering
    expect(ir.codegen.handlerRef).toBe("_h0");
  });

  it("detects constant responses during lowering", () => {
    const sm = new SourceManager();
    const source = makeSource(sm, "ping.get.ts", `export default () => ({ pong: true });`);

    const ir = lowerRoute("ping.get.ts", mustParse("ping.get.ts"), source, 0, 0);
    expect(ir.analysis.isConstantResponse).toBe(true);
    expect(ir.analysis.constantResponse).toBe(JSON.stringify({ pong: true }));
  });

  it("carries route config and named handler export into the IR", () => {
    const sm = new SourceManager();
    const source = makeSource(
      sm,
      "echo.get.ts",
      `import { get } from "@ignex/core";
export const config = { cache: { maxAge: 60 }, hooks: ["auth"] };
export const httpGet = get((ctx) => ctx.json({ ok: true }));
`,
    );

    const ir = lowerRoute("echo.get.ts", mustParse("echo.get.ts"), source, 1, 0);
    expect(ir.analysis.cache?.maxAge).toBe(60);
    expect(ir.analysis.hooks).toEqual(["auth"]);
    expect(ir.analysis.handlerExportName).toBe("httpGet");
    expect(ir.codegen.handlerRef).toBe("_h1");
  });

  it("produces immutable-ish sections — mutating decisions never touches source", () => {
    const sm = new SourceManager();
    const source = makeSource(sm, "a.get.ts", `export default () => ({ a: 1 });`);
    const ir = lowerRoute("a.get.ts", mustParse("a.get.ts"), source, 0, 0);

    const updated: RouteIR = {
      ...ir,
      decisions: { ...ir.decisions, shouldInline: true },
    };

    expect(updated.decisions.shouldInline).toBe(true);
    expect(ir.decisions.shouldInline).toBe(false); // original untouched
    expect(updated.source).toBe(ir.source); // source section shared (immutable facts)
  });
});

describe("optimization (IR decisions)", () => {
  beforeEach(() => {
    clearParseCache();
  });

  const routeFrom = (
    rel: string,
    content: string,
  ): { routes: RouteIR[]; sources: SourceManager } => {
    const sm = new SourceManager();
    const source = makeSource(sm, rel, content);
    const parsed = parseRouteFilename(rel);
    if (!parsed) throw new Error(`bad filename ${rel}`);
    return {
      routes: [lowerRoute(rel, parsed, source, 0, 0)],
      sources: sm,
    };
  };

  it("writes shouldInline into decisions for self-contained modules", () => {
    const { routes, sources } = routeFrom(
      "pure.get.ts",
      `export default (ctx) => ctx.json({ ok: true });`,
    );

    const opts = { ...createDefaultOptions(), inlineThreshold: 30 };
    const result = runOptimization(routes, sources.all(), opts, makeCtx());

    expect(result.routes[0]?.decisions.shouldInline).toBe(true);
    expect(result.routes[0]?.decisions.inlineCandidate?.body).toBeTruthy();
    expect(result.routes[0]?.decisions.inlineCandidate?.param).toBe("ctx");
  });

  it("does not inline modules that reference imports", () => {
    const { routes, sources } = routeFrom(
      "uses-import.get.ts",
      `import { helper } from "./helper";
export default (ctx) => helper(ctx);
`,
    );

    const opts = { ...createDefaultOptions(), inlineThreshold: 30 };
    const result = runOptimization(routes, sources.all(), opts, makeCtx());

    expect(result.routes[0]?.decisions.shouldInline).toBe(false);
    expect(result.routes[0]?.decisions.inlineCandidate).toBeUndefined();
  });
});
