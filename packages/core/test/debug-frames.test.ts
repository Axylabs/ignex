/**
 * Frame classification + failure summary tests — the "your code vs the
 * machinery" contract that makes a captured stack readable.
 *
 * The interesting cases are the ones a real stack produces: an error raised
 * inside a dependency across an `await` (its own stack has NO application
 * frame — Bun truncates at `processTicksAndRejections`, so the failing span's
 * origin supplies it), a synchronous application throw (its stack has the exact
 * line), and the build artifacts / synthetic frames that must never be presented
 * as if they were source.
 */

import { describe, expect, it } from "vitest";
import {
  classifyFrame,
  classifyLocation,
  failingOrigin,
  frameLocation,
  summarizeFailureFrames,
} from "../src/debug/frames";
import type { Span } from "../src/debug/types/index.js";

describe("classifyLocation", () => {
  it("recognizes the application's own code", () => {
    expect(classifyLocation("/srv/app/src/routes/api/gigs/index.get.ts:7:27")).toBe("app");
    expect(classifyLocation("/srv/app/src/models/gig.ts:12:5")).toBe("app");
  });

  it("recognizes the framework, installed or linked", () => {
    expect(classifyLocation("/repo/packages/core/src/lifecycle/run.ts:180:15")).toBe("framework");
    expect(classifyLocation("/app/node_modules/@ignex/core/dist/http/route.js:88:2")).toBe(
      "framework",
    );
    expect(classifyLocation("/repo/packages/shared/src/index.ts:1:1")).toBe("framework");
  });

  it("recognizes dependencies", () => {
    expect(classifyLocation("/app/node_modules/@ignex/ninox/src/errors/driver-map.ts:131:14")).toBe(
      "dependency",
    );
  });

  it("recognizes compiler output", () => {
    expect(classifyLocation("/app/dist-dev/.__server.js.entry.js:989:39")).toBe("generated");
    expect(classifyLocation("/app/dist/__server.js:50935:24")).toBe("generated");
    expect(classifyLocation("/app/.ignex/server.js:1:48213")).toBe("generated");
  });

  it("recognizes synthesized frames", () => {
    expect(classifyLocation("native:7:39")).toBe("synthetic");
    expect(classifyLocation("node:internal/process/task_queues:95:5")).toBe("synthetic");
    expect(classifyFrame("Error: kaboom")).toBe("none");
    expect(classifyFrame("    at async Promise.all (index 0)")).toBe("none");
  });

  it("reads the location out of a frame line", () => {
    expect(frameLocation("    at handler (/srv/app/src/a.ts:1:2)")).toBe("/srv/app/src/a.ts:1:2");
    expect(frameLocation("    at /srv/app/src/a.ts:3:4")).toBe("/srv/app/src/a.ts:3:4");
    expect(frameLocation("    at async node:internal/x:1:1")).toBe("node:internal/x:1:1");
  });
});

describe("summarizeFailureFrames", () => {
  /** A dependency-raised error: no application frame exists in ITS stack. */
  const dependencyStack = [
    "InfraError: Command aggregate requires authentication",
    "    at mapMongoDriverError (/app/node_modules/@x/db/src/errors/driver-map.ts:131:14)",
    "    at <anonymous> (/app/node_modules/@x/db/src/service/trace-db-op.ts:130:40)",
    "    at processTicksAndRejections (native:7:39)",
  ].join("\n");

  /** The caller chain the failing span recorded when it started. */
  const callerChain = [
    "    at <anonymous> (/srv/app/src/routes/api/gigs/index.get.ts:7:27)",
    "    at runTimed (/repo/packages/core/src/lifecycle/run.ts:180:15)",
    "    at GET__h4 (/app/dist-dev/.__server.js.entry.js:989:39)",
  ].join("\n");

  it("leads with the application call site the span recorded", () => {
    const frames = summarizeFailureFrames({ stack: dependencyStack, origins: [callerChain] });
    expect(frames?.appWhere).toBe("/srv/app/src/routes/api/gigs/index.get.ts:7:27");
    expect(frames?.app).toEqual([
      "at <anonymous> (/srv/app/src/routes/api/gigs/index.get.ts:7:27)",
    ]);
    // The machinery is kept, in capture order, minus the duplicated native frame.
    expect(frames?.internal[0]).toContain("driver-map.ts:131:14");
    expect(frames?.internal.some((f) => f.includes("run.ts:180:15"))).toBe(true);
    expect(frames?.internal.some((f) => f.includes(".__server.js.entry.js"))).toBe(true);
    expect(frames?.internal.every((f) => !f.includes("index.get.ts"))).toBe(true);
  });

  it("prefers an application frame in the error's OWN stack (the exact throw site)", () => {
    const syncStack = [
      "Error: id is required",
      "    at handler (/srv/app/src/routes/api/gigs/index.get.ts:42:11)",
      "    at runTimed (/repo/packages/core/src/lifecycle/run.ts:180:15)",
    ].join("\n");
    const frames = summarizeFailureFrames({ stack: syncStack, origins: [callerChain] });
    expect(frames?.appWhere).toBe("/srv/app/src/routes/api/gigs/index.get.ts:42:11");
    expect(frames?.app).toHaveLength(2); // both application frames, deduped
  });

  it("drops synthetic frames and dedupes repeated lines", () => {
    const frames = summarizeFailureFrames({
      stack: ["Error: x", "    at tick (native:7:39)", "    at tick (native:7:39)"].join("\n"),
    });
    expect(frames).toBeNull();
  });

  it("returns null when nothing usable was captured", () => {
    expect(summarizeFailureFrames({})).toBeNull();
    expect(summarizeFailureFrames({ stack: null, origins: [null, undefined] })).toBeNull();
  });
});

describe("failingOrigin", () => {
  const span = (id: number, parentId: number | null, origin: string | null): Span => ({
    id,
    parentId,
    name: `span-${id}`,
    kind: "custom",
    startMs: 0,
    durationMs: 1,
    open: false,
    attrs: null,
    error: null,
    origin,
  });

  const APP = "    at route (/srv/app/src/routes/x.ts:1:1)";

  it("walks outwards from the failing span to its ancestors", () => {
    // The real shape: the failing ORM span's own chain was truncated to a
    // synthetic frame; the application wrapper above it kept the route line.
    const spans = [span(0, null, null), span(4, 0, APP), span(5, 4, "    at tick (native:7:39)")];
    expect(failingOrigin(spans, 5)).toEqual(["    at tick (native:7:39)", APP]);
  });

  it("returns the failing span's own chain when it has one", () => {
    const spans = [span(0, null, null), span(1, 0, APP)];
    expect(failingOrigin(spans, 1)).toEqual([APP]);
  });

  it("degrades to an empty origin for an unknown or absent span", () => {
    expect(failingOrigin([span(1, 0, APP)], null)).toEqual([null]);
    expect(failingOrigin([span(1, 0, APP)], 99)).toEqual([null]);
  });
});
