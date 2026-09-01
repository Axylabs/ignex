/**
 * @fileoverview Tests for the source-map frame remapper (debug/sourcemaps.ts).
 *
 * The fixture map below mirrors what `@ignex/compiler` emits for a minified
 * one-line bundle: every mapping on generated line 0, sources referenced
 * relative to the map directory. Hand-computed VLQ keeps the vectors exact.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { debugQuery } from "../src/debug/api";
import {
  buildDecodedMappings,
  createSourceFrameResolver,
  decodeVlq,
  lookupMapping,
  parseFrameLocation,
  setSharedSourceFrames,
  sharedSourceFrames,
} from "../src/debug/sourcemaps";
import {
  beginTrace,
  enterTraceContext,
  isInternalFrame,
  setTracingEnabled,
} from "../src/debug/tracer";

/* ── VLQ decoder ────────────────────────────────────────────────────────── */

describe("decodeVlq", () => {
  it("decodes canonical base64-VLQ fields", () => {
    expect(decodeVlq("A")).toBe(0);
    expect(decodeVlq("C")).toBe(1); // 1<<1 = 2 → 'C'
    expect(decodeVlq("D")).toBe(-1); // sign bit set
    expect(decodeVlq("K")).toBe(5); // 5<<1 = 10 → 'K'
    expect(decodeVlq("gB")).toBe(16); // continuation field (32→'g', then 'B')
    expect(decodeVlq("iB")).toBe(17);
    expect(decodeVlq("sE")).toBe(70); // two-char multi-bit value
  });

  it("rejects invalid characters", () => {
    expect(() => decodeVlq("*")).toThrow(/invalid VLQ char/);
  });
});

/* ── mappings decode + lookup ───────────────────────────────────────────── */
/*
 * Fixture segments on generated line 0, encoded programmatically below
 * (hand-written multi-char VLQ is exactly how typos sneak in):
 *
 *   Absolute targets (source, srcLine, srcCol are CUMULATIVE across
 *   segments; the encoder emits per-segment DELTAS):
 *     seg1: genCol 0   → src0 ("../src/routes/users/[id].get.ts") line 9,  col 14
 *     seg2: genCol 30  → src0, line 11, col 3
 *     seg3: genCol 100 → src1 ("../src/lib/db.ts"),    line 16, col 3
 */
const SOURCES = ["../src/routes/users/[id].get.ts", "../src/lib/db.ts"];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Standard base64-VLQ encoding of one signed value (mirror of decodeVlq). */
const encodeVlq = (value: number): string => {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
};
const seg = (genCol: number, srcIdx: number, srcLine: number, srcCol: number): string =>
  encodeVlq(genCol) + encodeVlq(srcIdx) + encodeVlq(srcLine) + encodeVlq(srcCol);

// Deltas: s2 = (+30, +0, +2, −11) after s1; s3 = (+70, +1, +5, 0) after s2.
const MAPPINGS = [seg(0, 0, 9, 14), seg(30, 0, 2, -11), seg(70, 1, 5, 0)].join(",");

const fixtureMap = () => ({
  version: 3,
  sources: SOURCES,
  mappings: MAPPINGS,
});

describe("buildDecodedMappings + lookupMapping", () => {
  const decoded = buildDecodedMappings(MAPPINGS, SOURCES);

  it("lands exactly on segment boundaries", () => {
    const s1 = lookupMapping(decoded, 0, 0);
    expect(s1).toMatchObject({ source: SOURCES[0], srcLine: 9, srcCol: 14 });
    const s2 = lookupMapping(decoded, 0, 30);
    expect(s2).toMatchObject({ source: SOURCES[0], srcLine: 11, srcCol: 3 });
    const s3 = lookupMapping(decoded, 0, 100);
    expect(s3).toMatchObject({ source: SOURCES[1], srcLine: 16, srcCol: 3 });
  });

  it("attributes positions between segments to the preceding one", () => {
    expect(lookupMapping(decoded, 0, 29)?.genCol).toBe(0);
    expect(lookupMapping(decoded, 0, 45)?.srcLine).toBe(11);
    expect(lookupMapping(decoded, 0, Number.MAX_SAFE_INTEGER)?.genCol).toBe(100);
  });

  it("returns null for unknown generated lines", () => {
    expect(lookupMapping(decoded, 7, 0)).toBeNull();
  });
});

/* ── frame parsing ──────────────────────────────────────────────────────── */

describe("parseFrameLocation", () => {
  it("parses named V8/Bun frames", () => {
    const loc = parseFrameLocation("    at handler (/abs/.ignex/server.js:12:34)");
    expect(loc).not.toBeNull();
    expect(loc?.path).toBe("/abs/.ignex/server.js");
    expect(loc?.line).toBe(12);
    expect(loc?.column).toBe(34);
  });

  it("parses anonymous and crash-report frames", () => {
    expect(parseFrameLocation("    at /abs/bundle.js:1:50")?.path).toBe("/abs/bundle.js");
    expect(parseFrameLocation("/abs/bundle.js:2:8")?.line).toBe(2);
  });

  it("normalizes file:// URLs in the returned text", () => {
    const loc = parseFrameLocation("    at fn (file:///abs/x.js:3:4)");
    expect(loc?.path).toBe("/abs/x.js");
    expect(loc?.text).toBe("    at fn (/abs/x.js:3:4)");
  });

  it("rejects remote frames and non-location lines", () => {
    expect(parseFrameLocation("    at fn (https://cdn/x.js:1:2)")).toBeNull();
    expect(parseFrameLocation("Error: kaboom")).toBeNull();
  });
});

/* ── resolver with injected loader (no fs) ──────────────────────────────── */

describe("createSourceFrameResolver (injected loader)", () => {
  const resolver = createSourceFrameResolver({
    loadMap: (mapPath) => (mapPath.endsWith("server.js.map") ? fixtureMap() : null),
  });

  it("rewrites bundle frames to original TS positions (human 1-based)", () => {
    // column 101 → 0-based 100 → seg3 (db.ts line 16 col 3 → human 17:4).
    const out = resolver.remapFrame("    at handler (/app/.ignex/server.js:1:101)");
    expect(out).toBe("    at handler (/app/src/lib/db.ts:17:4)");
  });

  it("keeps the frame prefix intact for mid-line columns", () => {
    const out = resolver.remapFrame("    at fn (/app/.ignex/server.js:1:31)");
    expect(out).toBe("    at fn (/app/src/routes/users/[id].get.ts:12:4)");
  });

  it("passes through frames without an adjacent map", () => {
    const frame = "    at fn (/app/node_modules/pkg/index.js:3:4)";
    expect(resolver.remapFrame(frame)).toBe(frame);
  });

  it("passes through when the map is corrupt", () => {
    const corrupt = createSourceFrameResolver({
      loadMap: () => {
        throw new Error("boom");
      },
    });
    const frame = "    at fn (/app/.ignex/server.js:1:101)";
    expect(corrupt.remapFrame(frame)).toBe(frame);
  });
});

/* ── real-fs integration ────────────────────────────────────────────────── */

describe("createSourceFrameResolver (real .map files)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-smaps-"));
    writeFileSync(join(dir, "server.js.map"), JSON.stringify(fixtureMap()));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads <bundle>.js.map next to the frame's file", () => {
    const resolver = createSourceFrameResolver();
    // column 16 → 0-based 15 → seg1 → line 9+1=10, col 14+1=15. The source
    // resolves ABSOLUTE against the map's directory.
    const frame = `    at boom (${join(dir, "server.js")}:1:16)`;
    const out = resolver.remapFrame(frame);
    expect(out).toBe(`    at boom (${resolve(dir, SOURCES[0])}:10:15)`);
  });

  it("negative-caches map-less files (still correct after first miss)", () => {
    const resolver = createSourceFrameResolver();
    const frame = `    at x (${join(dir, "nomap.js")}:1:1)`;
    expect(resolver.remapFrame(frame)).toBe(frame);
    expect(resolver.remapFrame(frame)).toBe(frame);
  });
});

/* ── tracer wiring ──────────────────────────────────────────────────────── */

describe("tracer sourcemap wiring", () => {
  it("remaps errorStack and span origins through the shared resolver", async () => {
    setSharedSourceFrames(
      createSourceFrameResolver({
        loadMap: (p) => (p.endsWith("server.js.map") ? fixtureMap() : null),
      }),
    );
    try {
      const fakeCtx = {
        requestId: "sm-test",
        method: "GET",
        path: "/u/1",
        route: "/users/:id",
        ip: "127.0.0.1",
        req: { url: "http://localhost/u/1" },
        headers: new Headers(),
      } as Parameters<typeof beginTrace>[0];
      const trace = beginTrace(fakeCtx, false);
      const handle = trace.start("work", "custom");
      trace.end(handle);

      const err = new Error("kaboom");
      // Rewrite the stack so the top frame points at the bundled file.
      err.stack = [
        "Error: kaboom",
        "    at boom (/app/.ignex/server.js:1:101)",
        "    at other (/somewhere/else.js:9:9)",
      ].join("\n");
      trace.recordError(err);

      const wire = trace.toJSON();
      expect(wire.errorStack).toContain("/app/src/lib/db.ts:17:4");
      // Unmapped second frame passes through untouched.
      expect(wire.errorStack).toContain("/somewhere/else.js:9:9");
    } finally {
      setSharedSourceFrames(null); // restore lazy default
    }
  });

  it("restores the lazy default after reset", () => {
    expect(sharedSourceFrames()).toBeDefined();
  });

  it("keeps the complete stack in true order (framework/vendor frames included)", () => {
    setSharedSourceFrames(null); // default resolver; no maps → passthrough
    const fakeCtx = {
      requestId: "sm-order",
      method: "GET",
      path: "/u/1",
      route: "/users/:id",
      ip: "127.0.0.1",
      req: { url: "http://localhost/u/1" },
      headers: new Headers(),
    } as Parameters<typeof beginTrace>[0];
    const trace = beginTrace(fakeCtx, false);
    const err = new Error("kaboom");
    err.stack = [
      "Error: kaboom",
      "    at debugQuery (/repo/node_modules/@ignex/core/dist/debug/api.js:85:22)",
      "    at handler (/app/src/routes/api/gigs/index.post.ts:12:5)",
      "    at runPre (/repo/node_modules/@ignex/core/dist/lifecycle.js:401:9)",
      "    at async node:internal/process/task_queues:95:5",
    ].join("\n");
    trace.recordError(err);
    const wire = trace.toJSON();
    const lines = (wire.errorStack ?? "").split("\n");
    // Header first, then EVERY frame in the original call order — a full
    // start-to-finish chain (vendor and node internals included) so the
    // developer can trace where the error actually started.
    expect(lines[0]).toBe("Error: kaboom");
    expect(lines[1]).toContain("/repo/node_modules/@ignex/core/dist/debug/api.js");
    expect(lines[2]).toContain("/app/src/routes/api/gigs/index.post.ts");
    expect(lines[3]).toContain("/repo/node_modules/@ignex/core/dist/lifecycle.js");
    expect(lines[4]).toContain("node:internal/process/task_queues");
    expect(lines).toHaveLength(5);
  });

  it("span origins point at the application call site, not core wrappers", () => {
    setSharedSourceFrames(null); // default resolver; no maps → passthrough
    setTracingEnabled(true);
    try {
      const fakeCtx = {
        requestId: "sm-origin",
        method: "GET",
        path: "/u/1",
        route: "/users/:id",
        ip: "127.0.0.1",
        req: { url: "http://localhost/u/1" },
        headers: new Headers(),
      } as Parameters<typeof beginTrace>[0];
      const trace = beginTrace(fakeCtx, false);
      enterTraceContext(trace);
      // Called through the debugQuery WRAPPER — the old lines[3] heuristic
      // produced `at debugQuery (.../core/src/debug/api.ts:85:22)` here.
      debugQuery("SELECT 1", undefined, () => "ok");
      const dbSpan = trace.toJSON().spans.find((s) => s.kind === "db");
      expect(dbSpan?.origin).toBeDefined();
      // The origin is the FULL caller chain from the app call site down —
      // not a single wrapper frame — so it can be traced back to the
      // request entry point.
      expect(dbSpan?.origin).toContain("debug-sourcemaps.test.ts");
      expect(dbSpan?.origin).not.toContain("/debug/api.ts");
      expect((dbSpan?.origin ?? "").split("\n").length).toBeGreaterThan(1);
    } finally {
      setTracingEnabled(false);
    }
  });

  it("detects core-internal frames in EVERY install layout", () => {
    // Compiled bundle: DEBUG_SRC_DIR is the app's outDir, but sourcemapped
    // frames resolve back to core's source tree — path shapes must match.
    expect(
      isInternalFrame("    at callerOrigin (/repo/packages/core/src/debug/tracer.ts:179:21)"),
    ).toBe(true);
    expect(
      isInternalFrame("    at debugQuery (/app/node_modules/@ignex/core/dist/debug/api.js:85:22)"),
    ).toBe(true);
    expect(isInternalFrame("    at fn (/app/src/modules/gigs.ts:70:32)")).toBe(false);
    expect(isInternalFrame("    at async node:internal/process/task_queues:95:5")).toBe(true);
    expect(isInternalFrame("    at handler (/app/src/routes/api/gigs/index.post.ts:12:5)")).toBe(
      false,
    );
  });
});

/* ── full pipeline (Bun.build → minified bundle → remapped stack) ───────── */

const itBun = typeof Bun !== "undefined" ? it : it.skip;

describe("sourcemap end-to-end (requires Bun)", () => {
  itBun("remaps a real runtime stack from a minified bundle back to .ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-smaps-e2e-"));
    try {
      writeFileSync(
        join(dir, "orig.ts"),
        "export function deepBoom(n: number): never {\n" +
          "  if (n > 0) return deepBoom(n - 1);\n" +
          "  throw new Error('e2e-boom');\n" +
          "}\n",
      );
      writeFileSync(
        join(dir, "entry.ts"),
        'import { deepBoom } from "./orig";\n' +
          "try {\n" +
          "  deepBoom(3);\n" +
          "} catch (e) {\n" +
          "  (globalThis as Record<string, unknown>).__STACK__ = (e as Error).stack;\n" +
          "}\n" +
          "export {};\n",
      );
      const build = await Bun.build({
        entrypoints: [join(dir, "entry.ts")],
        outdir: join(dir, "out"),
        minify: true,
        sourcemap: "external",
        target: "bun",
        format: "esm",
      });
      expect(build.success).toBe(true);

      await import(pathToFileURL(join(dir, "out", "entry.js")).href);
      const stack = (globalThis as Record<string, string | undefined>).__STACK__ ?? "";
      expect(stack).toContain("out/entry.js"); // sanity: bundle coordinates raw

      const remap = createSourceFrameResolver().remapFrame;
      const remapped = stack.split("\n").map(remap).join("\n");
      // The throw lives at orig.ts line 3 — the map must take us there.
      expect(remapped).toMatch(/orig\.ts:3:\d+\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete (globalThis as Record<string, unknown>).__STACK__;
    }
  });
});
