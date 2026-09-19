/**
 * @fileoverview Codegen: generated-context construction.
 *
 * Two shapes are emitted per route:
 * - full context (`createContext` + lifecycle + validation) when the route
 *   needs hooks/validation/cookies/forwarding/file handling, and
 * - a usage-specialized object literal when only a subset of `ctx` members is
 *   referenced. Both are driven by the AST-derived ContextUsage.
 */

import type { ContextUsage } from "@ignex/shared";
import type { RouteIR } from "../../../types";
import { ctxOptsVar, handlerImportName, validatorImportName } from "../identifiers";
import { emitValidatorThrow, validationFlags } from "./validate";

/**
 * Every `ContextUsage` flag the specialized context actually EMITS a member
 * for. Anything else is a sentinel: codegen emits nothing and the flag just
 * forces `needsFull`.
 *
 * This is the authority for two things that must not drift apart — the
 * structural test in `test/context-members.test.ts` (which imports this set
 * rather than keeping its own list) and the codegen gate that decides whether
 * the plugin layer's declared usage is satisfiable on this tier.
 */
export const EMITTED_USAGE_FLAGS: ReadonlySet<keyof ContextUsage> = new Set([
  "body",
  "cookie",
  "forward",
  "headers",
  "html",
  "json",
  "method",
  "params",
  "path",
  "proxy",
  "query",
  "redirect",
  "req",
  "requestId",
  "route",
  "sendFile",
  "server",
  "set",
  "startTime",
  "state",
  "status",
  "stream",
  "text",
  "url",
  "ip",
  "empty",
] as (keyof ContextUsage)[]);

/**
 * Whether every member `usage` requires is one the specialized context emits.
 *
 * The plugin layer's hooks run against that context once the ladder is emitted,
 * so an undeclared-or-unemittable member would hand a hook `undefined` — the
 * exact failure this whole vocabulary exists to prevent. A `false` here keeps
 * the route on the full context.
 *
 * @param usage - The merged requirement of the plugin layer.
 * @returns `true` when the specialized context can satisfy it entirely.
 */
export const isUsageEmittable = (usage: ContextUsage): boolean => {
  for (const key of Object.keys(usage) as (keyof ContextUsage)[]) {
    if (usage[key] && !EMITTED_USAGE_FLAGS.has(key)) return false;
  }
  return true;
};

/** A `ContextUsage` with every field writable, for accumulation. */
type MutableUsage = { -readonly [K in keyof ContextUsage]: boolean };

/**
 * Merge a plugin layer's declared usage into a route's usage.
 *
 * The specialized object literal only emitted the members the ROUTE's handler
 * read — so a hook whose plugin declared `headers`/`req` read `undefined` on a
 * route that read only `ctx.json` (a runtime TypeError from `cors`/`security`
 * on otherwise-lean apps). The emitted context is the UNION of both usages:
 * every member a route OR its plugin layer touches must exist on the ctx the
 * hooks run against.
 */
export const mergeContextUsage = (
  routeUsage: ContextUsage,
  pluginUsage: Readonly<ContextUsage>,
): ContextUsage => {
  const merged: MutableUsage = { ...routeUsage };
  for (const key of Object.keys(pluginUsage) as (keyof ContextUsage)[]) {
    if (pluginUsage[key]) merged[key] = true;
  }
  return merged;
};

/**
 * Emit the members derived directly from the `Request`.
 *
 * Extracted from {@link buildContextProps} to keep that function's cognitive
 * complexity under the lint ceiling.
 */
const pushRequestMembers = (
  props: string[],
  usage: ContextUsage,
  usedCore: Set<string>,
  route: RouteIR,
): void => {
  if (usage.req) props.push(`req`);
  if (usage.url) props.push(`url`);
  // `ctx.method` is a plain Request property — no URL object needed. Emitting it
  // is what lets a method-reading route specialize at all: `method` used to set
  // the `url` flag, so codegen emitted `url` and the handler read
  // `ctx.method === undefined`.
  if (usage.method) props.push(`method: req.method`);
  // Same class of bug: `path` shared the `url` flag while NOTHING emitted a
  // `path` member. It reuses core's `pathnameOf` — the SAME helper the full
  // context uses — deliberately not `url.pathname`, which normalizes
  // dot-segments (`/a/../b` -> `/b`) where `pathnameOf` does not; using it would
  // make compiled and interpreted builds disagree on `ctx.path`.
  if (usage.path) {
    usedCore.add("pathnameOf");
    props.push(`path: pathnameOf(req.url)`);
  }
  // The request's identity. Each of these is a member the full context gets for
  // free (from `createContext`'s options or the impl's constructor) and the
  // specialized object literal used to omit — so a route reading one read
  // `undefined`. The emitted expressions are deliberately the SAME ones the full
  // context uses, so the two builds cannot disagree:
  //   - `route` is the same literal `__ctxOpts_<ref>` carries into
  //     `createContext` (`route.source.path`),
  //   - `startTime` mirrors the impl's `this.startTime = performance.now()`
  //     (both run at request dispatch), and
  //   - `requestId` calls the same generator the impl's lazy getter calls.
  // `ip` is emitted only when the handler reads it. `__TRUST_PROXY` is the
  // boot-folded plugin declaration, so this resolves the client exactly as the
  // full context does — including the forwarded-header branch that used to be
  // unreachable in compiled apps, where nothing ever set `trustProxy`.
  if (usage.route) props.push(`route: ${JSON.stringify(route.source.path)}`);
  if (usage.startTime) props.push(`startTime: performance.now()`);
  if (usage.requestId) {
    usedCore.add("generateRequestId");
    props.push(`requestId: generateRequestId()`);
  }
  if (usage.ip) {
    usedCore.add("resolveClientIp");
    props.push(`ip: resolveClientIp(server, req, __TRUST_PROXY)`);
  }
};

/**
 * Build the usage-specialized object-literal props for the handler call.
 *
 * Exported so `test/context-members.test.ts` can assert that every flag the
 * analyzer sets produces a member with the same name: a flag that is set but
 * never emitted leaves the handler reading `undefined` on the specialized tier
 * while the full context has a real value (`ctx.method` and `ctx.path` both
 * shipped that bug).
 *
 * @param route - Route IR supplying the usage bitmap and validator presence.
 * @param usedCore - Set the function adds core import names to as it emits.
 * @param usage - The usage to emit members for (defaults to the route's own).
 *   Callers pass the ROUTE ∪ PLUGIN-LAYER merge so hooks never read members the
 *   route itself did not reference.
 * @returns The generated property sources, in object-literal order.
 */
export const buildContextProps = (
  route: RouteIR,
  usedCore: Set<string>,
  usage: ContextUsage = route.analysis.usage,
): string[] => {
  const props: string[] = [];
  const hasParamsValidator = !!route.decisions.validators?.params;
  const hasQueryValidator = !!route.decisions.validators?.query;
  const hasHeadersValidator = !!route.decisions.validators?.headers;
  const hasBodyValidator = !!route.decisions.validators?.body;

  // Only expose `set` when the handler actually reads it. When nothing in the
  // request touches `ctx.set` / `ctx.cookie`, codegen emits the compact path
  // (no `__applySet` pass), so the handler never needs the member at all.
  if (usage.set) props.push(`set: __set`);

  if (usage.params || hasParamsValidator) props.push(`params: __params`);
  if (usage.body || hasBodyValidator) props.push(`body`);
  if (usage.query || hasQueryValidator) props.push(`query`);
  if (usage.headers || hasHeadersValidator) props.push(`headers: req.headers`);
  pushRequestMembers(props, usage, usedCore, route);
  if (usage.server) props.push(`server`);
  if (usage.state) {
    props.push(`state`);
    props.push(`getState: (key) => state.get(key)`);
    props.push(`setState: (key, value) => { state.set(key, value); }`);
  }
  if (usage.json) {
    props.push(`json: jsonReply`);
  }
  if (usage.text) {
    props.push(`text: textReply`);
  }
  if (usage.html) {
    props.push(`html: htmlReply`);
  }
  if (usage.stream) {
    props.push(`stream: streamReply`);
  }
  if (usage.redirect) {
    props.push(`redirect: redirectReply`);
  }
  if (usage.empty) {
    props.push(`empty: emptyReply`);
  }
  if (usage.status) {
    props.push(`status: statusReply`);
  }
  if (usage.sendFile) {
    usedCore.add("sendFile");
    props.push(`sendFile: (path, opts) => sendFile(path, { req, ...opts })`);
  }
  if (usage.cookie) {
    props.push(`cookie: __cookieJar`);
  }
  if (usage.proxy) {
    usedCore.add("proxyRequest");
    props.push(`proxy: (target, opts) => proxyRequest(target, { req, ...opts })`);
  }
  if (usage.forward) {
    usedCore.add("forwardRequest");
    props.push(`forward: (target, opts) => forwardRequest(req, target, opts)`);
  }

  return props;
};

/** Emit the full-context prelude (context creation + global pre-hooks). */
export const buildFullContextPrelude = (
  route: RouteIR,
  sync = false,
  resumeName = "",
): string[] => {
  // The per-route opts const (`__ctxOpts_<ref>`, frozen at module scope) is
  // emitted by `generateRouteCode` — the inline object literal used to be
  // re-allocated on every request.
  return [
    // Assignment (not `let`): the core fn declares `let ctx;` OUTSIDE the try
    // so the catch block can hand the real context to `__handleError`. A
    // `let` here would shadow the outer binding and pass `undefined` to
    // error-stage hooks (every compiled error lost its ctx).
    `ctx = createContext(req, params ?? EMPTY_PARAMS, ${ctxOptsVar(route)});`,
    `ctx.server = server;`,
    sync
      ? `{
  // start → request → parse → transform run before validation; the pre-parse
  // stage runs in delegation form (non-async core fn): on a Promise the
  // remainder is handed to the async resume (cold path — only fires for async
  // hooks, never for all-sync apps).
  if (__hasPreParse) {
    const __r = __runPreParse(ctx);
    if (__r instanceof Promise) return ${resumeName}(ctx, undefined, 1, __r);
    const __globalPre = __r;
    // The request stage is what creates the debug trace (the debugbar
    // plugin's onRequest runs inside it), so its waterfall row is recorded
    // the moment the chain returns. Const-folded away when no debugbar is
    // kept for this build (__TRACE_DEBUG = false).
    if (__TRACE_DEBUG) debugStageEnd("request");
    if (__globalPre.response) return __applySet(__globalPre.response, ctx.set);
    ctx = __globalPre.ctx ?? ctx;
  }
}`
      : `{
  // start → request → parse → transform run before validation; beforeHandle
  // and per-route hooks run after validation (see below). This keeps the
  // compiled stage order aligned with the interpreted runLifecycle. Skipped
  // entirely when no pre-parse hooks are registered.
  if (__hasPreParse) {
    const __r = __runPreParse(ctx);
    const __globalPre = __r instanceof Promise ? await __r : __r;
    // The request stage is what creates the debug trace (the debugbar
    // plugin's onRequest runs inside it), so its waterfall row is recorded
    // the moment the chain returns. Const-folded away when no debugbar is
    // kept for this build (__TRACE_DEBUG = false).
    if (__TRACE_DEBUG) debugStageEnd("request");
    if (__globalPre.response) return __applySet(__globalPre.response, ctx.set);
    ctx = __globalPre.ctx ?? ctx;
  }
}`,
  ];
};

/**
 * Emit the usage-specialized context: the prelude lines that materialize only
 * the `ctx` members the handler references, plus the object-literal call
 * expression passed to the imported handler.
 */
export const buildSpecializedContext = (
  route: RouteIR,
  usedCore: Set<string>,
  sync = false,
  resumeName = "",
  mayMutateSet = false,
  usage: ContextUsage = route.analysis.usage,
): { pre: string[]; callExpr: string } => {
  const { hasParamsValidator, hasQueryValidator, hasHeadersValidator, hasBodyValidator } =
    validationFlags(route);

  const pre: string[] = [];

  pre.push(`const __params = params ?? EMPTY_PARAMS;`);

  if (hasParamsValidator) {
    pre.push(emitValidatorThrow(validatorImportName(route, "params"), "params", "__params"));
  }

  const needUrl = usage.url || (usage.query && !hasQueryValidator);

  if (needUrl) {
    pre.push(`const url = new URL(req.url);`);
  }

  if (usage.query || hasQueryValidator) {
    if (hasQueryValidator) {
      usedCore.add("parseQueryFromURL");
      pre.push(`const query = parseQueryFromURL(req.url);`);
      pre.push(emitValidatorThrow(validatorImportName(route, "query"), "query", "query"));
    } else {
      pre.push(`const query = url.searchParams;`);
    }
  }

  if (usage.headers || hasHeadersValidator) {
    if (hasHeadersValidator) {
      usedCore.add("headersToRecord");
      pre.push(`const __headers = headersToRecord(req.headers);`);
      pre.push(emitValidatorThrow(validatorImportName(route, "headers"), "headers", "__headers"));
    }
  }

  if (usage.body || hasBodyValidator) {
    usedCore.add("createLazyBody");

    pre.push(`let body = createLazyBody(req, BODY_LIMITS);`);

    if (hasBodyValidator) {
      pre.push(`const __body = await body.json();`);
      pre.push(emitValidatorThrow(validatorImportName(route, "body"), "body", "__body"));
      pre.push(`body.json = async () => __body;`);
    }
  }

  if (usage.state) {
    pre.push(`const state = new Map();`);
  }

  // `mayMutateSet`: a registered plugin's hook can write `ctx.set` even when
  // neither the handler nor any route hook reads it. `__EMPTY_SET` is a FROZEN
  // empty record, so handing it to a hook would throw on the write instead of
  // being applied — and the compact path would drop the mutation anyway.
  if (usage.set || usage.cookie || mayMutateSet) {
    pre.push(`const __set = { headers: Object.create(null), cookie: Object.create(null) };`);
  } else {
    pre.push(`const __set = __EMPTY_SET;`);
  }

  if (usage.cookie) {
    // Lazy jar: the Cookie header is parsed on first read (cached), so a
    // handler reading a single cookie does not pay for eagerly parsing the
    // full header up front (the old `createCookieJar(__set, {}, …)` path also
    // passed parsed cookies as `initial`, so values were never exposed).
    usedCore.add("createLazyCookieJar");
    pre.push(`const __cookieJar = createLazyCookieJar(__set, () => req.headers.get("cookie"));`);
  }

  const props = buildContextProps(route, usedCore, usage);

  // Materialize the specialized context as a `ctx` VARIABLE instead of an
  // inline object literal. The tier is reachable with plugins registered now,
  // and the request ladder below can REPLACE the context
  // (`ctx = __globalPre.ctx ?? ctx`), which an inline literal cannot express.
  //
  // Assignment, never `let`: the core fn declares `let ctx;` OUTSIDE the try so
  // the error path can see the real context — a `let` here would shadow that
  // binding and hand `__handleError` an undefined ctx. Passing `ctx` costs
  // nothing extra (the literal has to be materialized either way) and lets
  // `__finalize` read `ctx.set` instead of allocating `{ set: __set }`.
  pre.push(`ctx = { ${props.join(", ")} };`);

  // The request stage (a plugin's `onRequest`, the debugbar trace opener) runs
  // BEFORE the handler, so it must run here too — otherwise registering a
  // plugin would silently skip it on every specialized route. Guarded by the
  // `__hasPreParse` boot constant, so an app with no such hook const-folds the
  // block away and this tier is byte-for-byte unchanged for it.
  pre.push(
    sync
      ? `if (__hasPreParse) {
  const __r = __runPreParse(ctx);
  if (__r instanceof Promise) return ${resumeName}(ctx, undefined, 1, __r);
  const __globalPre = __r;
  if (__TRACE_DEBUG) debugStageEnd("request");
  if (__globalPre.response) return __applySet(__globalPre.response, ctx.set);
  ctx = __globalPre.ctx ?? ctx;
}`
      : `if (__hasPreParse) {
  const __r = __runPreParse(ctx);
  const __globalPre = __r instanceof Promise ? await __r : __r;
  if (__TRACE_DEBUG) debugStageEnd("request");
  if (__globalPre.response) return __applySet(__globalPre.response, ctx.set);
  ctx = __globalPre.ctx ?? ctx;
}`,
  );

  return { pre, callExpr: `${handlerImportName(route)}(ctx)` };
};
