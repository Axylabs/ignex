/**
 * @fileoverview Debugbar API endpoint table — ONE declarative list that drives
 * both serving modes:
 *
 * - **AOT mode** (`onRequest` interception): `dispatch()` matches the request
 *   path against this table (O(segments), no if-chain).
 * - **Interpreted mode**: `registerRoutes()` walks the same table and registers
 *   router routes — previously a hand-maintained duplicate of the dispatcher
 *   that could silently drift.
 *
 * Auth is declared per endpoint (`gate` = normal header/cookie check,
 * `ticket` = single-use SSE ticket, `public` = nothing).
 */

import type { IgnexContext } from "../../http/context";
import type { IgnexRouter } from "../../http/router";
import { json, notFound } from "../respond";
import {
  createAiSummaryHandler,
  createClientsHandler,
  createEventPublishHandler,
  createEventsClearHandler,
  createEventsHandler,
  createJobsHandler,
  createKtData,
  createNovaClearHandler,
  createNovaEventsHandler,
  createRoutesHandler,
  createSdksHandler,
  createStateHandler,
} from "./handlers/app-panels";
import {
  createDiagnosticsGcHandler,
  createDiagnosticsHandler,
  createHistoryDetailHandler,
  createHistoryHandler,
  createLogDetailHandler,
  createLogsClearHandler,
  createLogsHandler,
  createMetaHandler,
  createMetricsHandler,
  createMetricsPrometheusHandler,
  createReplayHandler,
  createRequestDetailHandler,
  createRequestsClearHandler,
  createRequestsHandler,
  createSystemHandler,
} from "./handlers/data-panels";
import type { RouteFileIndex } from "./route-index";
import type { StreamHub } from "./stream";
import type { HandlerDeps } from "./types";

/** How an endpoint authenticates. */
export type EndpointAuth = "gate" | "ticket";

export interface EndpointDef {
  /** HTTP methods accepted (clears accept both for dev convenience). */
  readonly methods: Array<"GET" | "POST">;
  /** Path under `/api`, `:` prefix marks a parameter segment. */
  readonly pattern: string;
  readonly auth: EndpointAuth;
  handle: (ctx: IgnexContext, params: Record<string, string>) => Response | Promise<Response>;
}

export interface EndpointTable {
  readonly endpoints: EndpointDef[];
  /** Match + run an endpoint for an `/api/…` sub-path (AOT mode). */
  dispatch: (apiPath: string, ctx: IgnexContext) => Promise<Response> | Response;
  /** Register every endpoint as router routes (interpreted mode). */
  registerRoutes: (router: IgnexRouter, basePath: string) => void;
}

/** Build the full endpoint table for one debugbar instance. */
export const createEndpointTable = (
  deps: HandlerDeps,
  routeIndex: RouteFileIndex,
  streamHub: StreamHub,
): EndpointTable => {
  const ktData = createKtData(deps);

  const requestDetail = createRequestDetailHandler(deps, routeIndex);
  const replay = createReplayHandler(deps);
  const stateHandler = createStateHandler(deps, ktData);
  const sdksHandler = createSdksHandler(deps, ktData);
  const routesHandler = createRoutesHandler(deps, ktData);
  const aiSummary = createAiSummaryHandler(deps, ktData);
  const jobsHandler = createJobsHandler(deps);

  // Ticket minting goes through the normal auth gate; the stream itself
  // consumes tickets (declared below).
  const streamTicket = (ctx: IgnexContext): Response => {
    void ctx;
    return new Response(JSON.stringify({ ticket: streamHub.mintTicket() }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };

  const endpoints: EndpointDef[] = [
    { methods: ["GET"], pattern: "meta", auth: "gate", handle: () => createMetaHandler(deps)() },
    {
      methods: ["GET"],
      pattern: "system",
      auth: "gate",
      handle: () => createSystemHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "requests",
      auth: "gate",
      handle: (ctx) => createRequestsHandler(deps)(ctx),
    },
    {
      methods: ["GET", "POST"],
      pattern: "requests/clear",
      auth: "gate",
      handle: () => createRequestsClearHandler(deps)(),
    },
    {
      methods: ["POST"],
      pattern: "requests/:id/replay",
      auth: "gate",
      handle: (ctx, p) => replay(ctx, p.id as string),
    },
    {
      methods: ["GET"],
      pattern: "requests/:id",
      auth: "gate",
      handle: (_ctx, p) => requestDetail(p.id as string),
    },
    {
      methods: ["GET"],
      pattern: "history",
      auth: "gate",
      handle: (ctx) => createHistoryHandler(deps)(ctx),
    },
    {
      methods: ["GET"],
      pattern: "history/:id",
      auth: "gate",
      handle: (_ctx, p) => createHistoryDetailHandler(deps)(p.id as string),
    },
    {
      methods: ["GET"],
      pattern: "logs",
      auth: "gate",
      handle: (ctx) => createLogsHandler(deps)(ctx),
    },
    {
      methods: ["GET", "POST"],
      pattern: "logs/clear",
      auth: "gate",
      handle: () => createLogsClearHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "logs/:id",
      auth: "gate",
      handle: (_ctx, p) => createLogDetailHandler(deps)(p.id as string),
    },
    {
      methods: ["GET"],
      pattern: "metrics",
      auth: "gate",
      handle: () => createMetricsHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "metrics/prometheus",
      auth: "gate",
      handle: () => createMetricsPrometheusHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "diagnostics",
      auth: "gate",
      handle: () => createDiagnosticsHandler(deps)(),
    },
    {
      methods: ["POST"],
      pattern: "diagnostics/gc",
      auth: "gate",
      handle: () => createDiagnosticsGcHandler()(),
    },
    { methods: ["GET"], pattern: "state", auth: "gate", handle: () => stateHandler() },
    { methods: ["GET"], pattern: "kt", auth: "gate", handle: async () => json(await ktData()) },
    {
      methods: ["GET"],
      pattern: "sdks",
      auth: "gate",
      handle: async () => json(await sdksHandler()),
    },
    {
      methods: ["GET"],
      pattern: "clients",
      auth: "gate",
      handle: (ctx) => createClientsHandler(deps)(ctx),
    },
    { methods: ["GET"], pattern: "jobs", auth: "gate", handle: async () => await jobsHandler() },
    {
      methods: ["GET"],
      pattern: "routes",
      auth: "gate",
      handle: async () => await routesHandler(),
    },
    {
      methods: ["GET"],
      pattern: "events",
      auth: "gate",
      handle: (ctx) => createEventsHandler(deps)(ctx),
    },
    {
      methods: ["POST"],
      pattern: "events/publish",
      auth: "gate",
      handle: async (ctx) => await createEventPublishHandler(deps)(ctx),
    },
    {
      methods: ["POST"],
      pattern: "events/clear",
      auth: "gate",
      handle: () => createEventsClearHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "nova/events",
      auth: "gate",
      handle: (ctx) => createNovaEventsHandler(deps)(ctx),
    },
    {
      methods: ["POST"],
      pattern: "nova/events/clear",
      auth: "gate",
      handle: () => createNovaClearHandler(deps)(),
    },
    {
      methods: ["GET"],
      pattern: "ai/summary",
      auth: "gate",
      handle: async () => await aiSummary(),
    },
    {
      methods: ["POST"],
      pattern: "stream/ticket",
      auth: "gate",
      handle: (ctx) => streamTicket(ctx),
    },
    {
      methods: ["GET"],
      pattern: "stream",
      auth: "ticket",
      handle: (ctx) => streamHub.handle(ctx, ctx.url.searchParams.get("ticket")),
    },
  ];

  /** Match an api sub-path against the table; null = no route. */
  const match = (
    apiPath: string,
    method: string,
  ): { def: EndpointDef; params: Record<string, string>; methodMismatch: boolean } | null => {
    const want = apiPath.replace(/^\/+/, "").split("/").filter(Boolean);
    let methodMismatch = false;
    for (const def of endpoints) {
      const parts = def.pattern.split("/");
      if (parts.length !== want.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as string;
        const seg = want[i] as string;
        if (part.startsWith(":")) params[part.slice(1)] = seg;
        else if (part !== seg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!def.methods.includes(method as "GET" | "POST")) {
        methodMismatch = true;
        continue;
      }
      return { def, params, methodMismatch };
    }
    return methodMismatch ? { methodMismatch, def: null as never, params: {} } : null;
  };

  return {
    endpoints,
    dispatch: (apiPath, ctx) => {
      const found = match(apiPath, ctx.method);
      if (found === null) return notFound();
      if (found.def === null) return methodNotAllowed();
      return found.def.handle(ctx, found.params);
    },
    registerRoutes: (router, basePath) => {
      for (const def of endpoints) {
        const routePath = `${basePath}/api/${def.pattern}`;
        const runner = (ctx: IgnexContext): Response | Promise<Response> =>
          def.handle(ctx, collectParams(routePath, ctx));
        for (const method of def.methods) {
          if (method === "GET") router.get(routePath, runner);
          else router.post(routePath, runner);
        }
      }
    },
  };
};

/** Collect :params for a matched router route (router stores them on ctx.params). */
const collectParams = (routePath: string, ctx: IgnexContext): Record<string, string> => {
  const out: Record<string, string> = {};
  const defined = ctx.params ?? {};
  for (const part of routePath.split("/")) {
    if (part.startsWith(":")) {
      const key = part.slice(1);
      const value = (defined as Record<string, string | undefined>)[key];
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
};

const jsonHeaders = (): Headers => {
  const h = new Headers();
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return h;
};

const methodNotAllowed = (): Response =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: jsonHeaders(),
  });
