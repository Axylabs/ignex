/**
 * Fault-aware debugger tests — the dashboard must carry the SAME classification
 * the terminal reporter prints, so a failure is traceable to its root cause from
 * the trace itself:
 *
 *   - the trace and the failing SPAN carry origin/kind/code (`FaultMark`),
 *   - the detail carries the full fault (summary, hints, sanitized cause chain,
 *     `where`, retryable),
 *   - a failure that was HANDLED still classifies the span that failed,
 *   - the ring filters by fault code and the search matches it,
 *   - the AI summary exposes the classification + a fault-code histogram.
 */

import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { DBError } from "../src/platform/operational-errors.js";
import { debugbar } from "../src/plugins/debugbar.js";

/** Minimal stand-in for the Bun server handle the app factory expects. */
const server = { requestIP: () => null };

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

type App = { handler(request: Request, srv?: unknown): Promise<Response> };

const run = (app: App, path: string, init: RequestInit = {}): Promise<Response> =>
  app.handler(req(path, init), server);

/** A Mongo-shaped driver error: the real failure sits behind `cause`. */
const driverError = (): Error =>
  Object.assign(new Error("Command create requires authentication"), {
    name: "MongoServerError",
    code: 13,
  });

/** Fetch a debugbar JSON endpoint through the app (AOT interception path). */
const api = async <T>(app: App, path: string): Promise<T> =>
  (await run(app, `/__debugbar/api${path}`)).json() as Promise<T>;

interface FaultRow {
  id: string;
  path: string;
  error: string | null;
  fault?: { code: string; origin: string; kind: string; service?: string } | null;
}

interface FaultDetail {
  path: string;
  status: number;
  error: string | null;
  errorStack: string | null;
  faultSpanId?: number | null;
  fault?: {
    code: string;
    origin: string;
    kind: string;
    service?: string;
    status: number;
    summary: string;
    retryable: boolean;
    hints: string[];
    where?: string;
    causes: Array<{ name: string; message: string; code?: string }>;
  } | null;
  spans: Array<{
    id: number;
    name: string;
    fault?: { code: string; origin: string; kind: string } | null;
    attrs?: Record<string, unknown> | null;
  }>;
}

describe("fault-aware debugger", () => {
  it("classifies a typed failure onto the trace and the request list", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async () => {
        throw new DBError("insertOne on gigs failed", {
          kind: "credentials",
          service: "MongoDB",
          collection: "gigs",
          code: "IGN_DB_CREDENTIALS",
          cause: driverError(),
        });
      },
    });

    expect((await run(app, "/api/gigs", { method: "POST" })).status).toBe(503);

    const rows = await api<FaultRow[]>(app, "/requests?error=1");
    expect(rows).toHaveLength(1);
    // The LIST carries the compact mark, so runs group by fault code.
    expect(rows[0]?.fault).toMatchObject({
      code: "IGN_DB_CREDENTIALS",
      origin: "db",
      kind: "credentials",
      service: "MongoDB",
    });

    const detail = await api<FaultDetail>(app, `/requests/${rows[0]?.id}`);
    expect(detail.status).toBe(503);
    expect(detail.errorStack).toBeTruthy();
    // The detail carries the whole classification the report renders.
    expect(detail.fault).toMatchObject({
      code: "IGN_DB_CREDENTIALS",
      origin: "db",
      kind: "credentials",
      service: "MongoDB",
      status: 503,
      summary: "MongoDB rejected the credentials",
      retryable: false,
    });
    // Operator guidance — the "what do I change" half of the report.
    expect(detail.fault?.hints[0]).toContain("MONGO_URL");
    // The root cause: the driver error behind the typed one.
    expect(detail.fault?.causes[0]).toMatchObject({ name: "MongoServerError", code: "13" });
    // And where it was thrown (first application frame).
    expect(detail.fault?.where).toBeTruthy();
  });

  it("anchors the failure on the span that broke", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        await ctx.debug.span("db: read gigs", "db", async () => {
          throw new DBError("read failed", { kind: "credentials", service: "MongoDB" });
        });
        return new Response("unreachable");
      },
    });

    await run(app, "/api/gigs");
    const rows = await api<FaultRow[]>(app, "/requests?error=1");
    const detail = await api<FaultDetail>(app, `/requests/${rows[0]?.id}`);

    const span = detail.spans.find((s) => s.name === "db: read gigs");
    expect(span?.fault).toMatchObject({ origin: "db", kind: "credentials" });
    // `faultSpanId` points the waterfall at the stage that failed.
    expect(detail.faultSpanId).toBe(span?.id);

    // The error event row explains itself in the waterfall (no tab needed).
    const event = detail.spans.find((s) => s.name.startsWith("error: "));
    expect(event?.attrs).toMatchObject({ origin: "db", kind: "credentials", retryable: false });
    expect(String(event?.attrs?.code)).toContain("IGN_DB");
  });

  it("classifies a span failure that the handler handled", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        try {
          await ctx.debug.span("cache warm", "cache", async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
          });
        } catch {
          // Handled: the request still succeeds, but the trace should say why
          // the span failed rather than only that it did.
        }
        return new Response("ok");
      },
    });

    expect((await run(app, "/warm")).status).toBe(200);
    const rows = await api<FaultRow[]>(app, "/requests");
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.fault ?? null).toBeNull();

    const detail = await api<FaultDetail>(app, `/requests/${rows[0]?.id}`);
    const span = detail.spans.find((s) => s.name === "cache warm");
    expect(span?.fault).toMatchObject({ origin: "network", kind: "unreachable" });
  });

  it("locates the failure in the application's own code", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async () => {
        const err = new Error("id is required");
        // The real shape of a compiled request: application frame, framework
        // lifecycle, the generated entry, then a synthetic tick frame.
        err.stack = [
          "Error: id is required",
          "    at handler (/srv/app/src/routes/api/gigs/index.get.ts:42:11)",
          "    at runTimed (/repo/packages/core/src/lifecycle/run.ts:180:15)",
          "    at GET__h4 (/app/dist-dev/.__server.js.entry.js:989:39)",
          "    at processTicksAndRejections (native:7:39)",
        ].join("\n");
        throw err;
      },
    });

    await run(app, "/api/gigs");
    const rows = await api<FaultRow[]>(app, "/requests?error=1");
    const detail = await api<FaultDetail>(app, `/requests/${rows[0]?.id}`);

    // Business logic first — the file an operator opens.
    expect(detail.faultFrames?.appWhere).toBe("/srv/app/src/routes/api/gigs/index.get.ts:42:11");
    expect(detail.faultFrames?.app).toEqual([
      "at handler (/srv/app/src/routes/api/gigs/index.get.ts:42:11)",
    ]);
    // Then the machinery that carried it, minus the synthetic frame.
    const internal = detail.faultFrames?.internal ?? [];
    expect(internal.some((f) => f.includes("run.ts:180:15"))).toBe(true);
    expect(internal.some((f) => f.includes(".__server.js.entry.js"))).toBe(true);
    expect(internal.some((f) => f.includes("native:"))).toBe(false);
  });

  it("names the application line in the terminal report too", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createApp({
        plugins: [debugbar({ enabled: true })],
        handler: async () => {
          const err = new Error("kaboom");
          err.stack = [
            "Error: kaboom",
            "    at handler (/srv/app/src/routes/api/gigs/index.get.ts:7:27)",
            "    at processTicksAndRejections (native:7:39)",
          ].join("\n");
          throw err;
        },
      });

      await run(app, "/api/gigs");
      // The report the operator sees on stderr carries the business line — the
      // trace resolved it before `errorToResponse` printed (`in code` leads the
      // `where` frame that actually raised the error).
      const printed = spy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(printed).toContain("in code  /srv/app/src/routes/api/gigs/index.get.ts:7:27");
    } finally {
      spy.mockRestore();
    }
  });

  it("hands the AI summary the business location too", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async () => {
        const err = new Error("id is required");
        err.stack = [
          "Error: id is required",
          "    at handler (/srv/app/src/routes/api/gigs/index.get.ts:42:11)",
        ].join("\n");
        throw err;
      },
    });

    await run(app, "/api/gigs");
    const summary = await api<{ traces: { recentErrors: Array<{ appWhere?: string | null }> } }>(
      app,
      "/ai/summary",
    );
    expect(summary.traces.recentErrors[0]?.appWhere).toBe(
      "/srv/app/src/routes/api/gigs/index.get.ts:42:11",
    );
  });

  it("filters and searches the ring by fault code", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        if (ctx.url.searchParams.get("mode") === "db") {
          throw new DBError("boom", {
            kind: "credentials",
            service: "MongoDB",
            code: "IGN_DB_CREDENTIALS",
          });
        }
        throw new Error("totally unexpected");
      },
    });

    await run(app, "/db-fail?mode=db");
    await run(app, "/other-fail");

    const onlyDb = await api<FaultRow[]>(app, "/requests?code=IGN_DB_CREDENTIALS");
    expect(onlyDb.map((r) => r.path)).toEqual(["/db-fail"]);
    expect(await api<FaultRow[]>(app, "/requests?code=NOT_A_CODE")).toHaveLength(0);
    // The free-text search matches the code as well as the message.
    const searched = await api<FaultRow[]>(app, "/requests?q=IGN_DB_CREDENTIALS");
    expect(searched.map((r) => r.path)).toEqual(["/db-fail"]);
  });

  it("hands the AI summary the classification and a fault-code histogram", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async () => {
        throw new DBError("insertOne on gigs failed", {
          kind: "credentials",
          service: "MongoDB",
          code: "IGN_DB_CREDENTIALS",
          cause: driverError(),
        });
      },
    });

    await run(app, "/api/gigs", { method: "POST" });
    const summary = await api<{
      traces: {
        errorCodes?: Record<string, number>;
        recentErrors: Array<{
          code?: string | null;
          origin?: string | null;
          kind?: string | null;
          service?: string | null;
          retryable?: boolean | null;
          cause?: string | null;
          hints?: string[];
        }>;
      };
    }>(app, "/ai/summary");

    expect(summary.traces.errorCodes).toMatchObject({ IGN_DB_CREDENTIALS: 1 });
    const [first] = summary.traces.recentErrors;
    expect(first).toMatchObject({
      code: "IGN_DB_CREDENTIALS",
      origin: "db",
      kind: "credentials",
      service: "MongoDB",
      retryable: false,
    });
    expect(first?.cause).toContain("MongoServerError");
    expect(first?.hints?.[0]).toContain("MONGO_URL");
  });
});
