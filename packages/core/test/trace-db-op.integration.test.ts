/**
 * traceDbOp — optional ignex-debugbar integration.
 *
 * `traceDbOp` wraps every managed DB operation. When the app runs inside
 * ignex with the debugbar enabled, each op is recorded as a `db` span in the
 * current request's trace (waterfall + Queries tab + db-time aggregate);
 * otherwise it is a plain pass-through. These tests need no MongoDB — they
 * exercise the wrapper directly against a synthetic ignex trace.
 */

import { existsSync } from "node:fs";
import { createContext } from "@ignex/core";
import * as debugMod from "@ignex/core/debug";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * `traceDbOp` lives in the EXTERNAL ignex-mongodb repo (a sibling checkout at
 * `../../..`, `bun link`-ed in full local-dev setups). Skip this suite when
 * that repo is not present so a standalone monorepo checkout verifies cleanly.
 */
const TRACE_DB_OP_MODULE = new URL(
  "../../../../ignex-mongodb/src/service/trace-db-op.ts",
  import.meta.url,
);
const hasTraceDbOp = existsSync(TRACE_DB_OP_MODULE);

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface TraceDbOpMeta {
  collection: string;
  db: string;
  op: string;
}

type TraceDbOp = <T>(
  logger: typeof noopLogger,
  meta: TraceDbOpMeta,
  operation: () => Promise<T>,
) => Promise<T>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Activate a synthetic ignex trace (the same ALS the debugbar plugin seeds). */
const withTrace = async <T>(fn: (trace: { toJSON(): unknown }) => Promise<T>): Promise<T> => {
  debugMod.setTracingEnabled(true);
  try {
    const ctx = createContext(new Request("http://localhost:3000/gigs"), {}, {});
    const trace = debugMod.beginTrace(ctx, false);
    debugMod.enterTraceContext(trace);
    return await fn(trace);
  } finally {
    debugMod.setTracingEnabled(false);
  }
};

describe.runIf(hasTraceDbOp)("traceDbOp (ignex-debugbar integration)", () => {
  let traceDbOp: TraceDbOp;

  beforeAll(async () => {
    const mod = (await import(TRACE_DB_OP_MODULE.href)) as { traceDbOp?: unknown };
    traceDbOp = mod.traceDbOp as TraceDbOp;
  });
  test("passes through without an active trace (returns the result)", async () => {
    const result = await traceDbOp(
      noopLogger,
      { collection: "gigs", db: "app", op: "find" },
      async () => ({ _id: "1" }),
    );
    expect(result).toEqual({ _id: "1" });
  });

  test("records a `db` span in the active request trace", async () => {
    await withTrace(async (trace) => {
      await traceDbOp(noopLogger, { collection: "gigs", db: "app", op: "find" }, async () => {
        await sleep(1);
        return { _id: "1" };
      });
      const json = trace.toJSON() as {
        dbCount: number;
        dbTimeMs: number;
        spans: Array<{ name: string; kind: string; durationMs: number }>;
      };
      const span = json.spans.find((s) => s.kind === "db");
      expect(span?.name).toBe("gigs.find");
      expect(span?.durationMs).toBeGreaterThanOrEqual(0.5);
      expect(json.dbCount).toBe(1);
      expect(json.dbTimeMs).toBeGreaterThanOrEqual(0.5);
    });
  });

  test("records a failed `db` span when the operation throws (error still propagates)", async () => {
    await withTrace(async (trace) => {
      await expect(
        traceDbOp(noopLogger, { collection: "gigs", db: "app", op: "insertOne" }, async () => {
          throw new Error("dup key");
        }),
      ).rejects.toThrow("dup key");
      const json = trace.toJSON() as {
        spans: Array<{ name: string; kind: string; error: string | null }>;
      };
      const span = json.spans.find((s) => s.name === "gigs.insertOne");
      expect(span?.kind).toBe("db");
      expect(span?.error).toContain("dup key");
    });
  });
});
