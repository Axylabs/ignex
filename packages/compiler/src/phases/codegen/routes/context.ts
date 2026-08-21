/**
 * @fileoverview Codegen: generated-context construction.
 *
 * Two shapes are emitted per route:
 * - full context (`createContext` + lifecycle + validation) when the route
 *   needs hooks/validation/cookies/forwarding/file handling, and
 * - a usage-specialized object literal when only a subset of `ctx` members is
 *   referenced. Both are driven by the AST-derived ContextUsage.
 */

import type { Emitter } from "../../../emitter";
import type { RouteIR } from "../../../types";
import { ctxOptsVar, handlerImportName, validatorImportName } from "../identifiers";
import { emitValidatorThrow, validationFlags } from "./validate";

/** Build the usage-specialized object-literal props for the handler call. */
const buildContextProps = (route: RouteIR, helpers: Emitter): string[] => {
  const props: string[] = [];
  const usage = route.analysis.usage;
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
  if (usage.req) props.push(`req`);
  if (usage.url) props.push(`url`);
  if (usage.server) props.push(`server`);
  if (usage.state) {
    props.push(`state`);
    props.push(`getState: (key) => state.get(key)`);
    props.push(`setState: (key, value) => { state.set(key, value); }`);
  }
  if (usage.json) {
    helpers.markUsed("jsonReply");
    props.push(`json: jsonReply`);
  }
  if (usage.text) {
    helpers.markUsed("textReply");
    props.push(`text: textReply`);
  }
  if (usage.html) {
    helpers.markUsed("htmlReply");
    props.push(`html: htmlReply`);
  }
  if (usage.stream) {
    helpers.markUsed("streamReply");
    props.push(`stream: streamReply`);
  }
  if (usage.redirect) {
    helpers.markUsed("redirectReply");
    props.push(`redirect: redirectReply`);
  }
  if (usage.empty) {
    helpers.markUsed("emptyReply");
    props.push(`empty: emptyReply`);
  }
  if (usage.status) {
    helpers.markUsed("statusReply");
    props.push(`status: statusReply`);
  }
  if (usage.sendFile) {
    helpers.markCore("sendFile");
    props.push(`sendFile: (path, opts) => sendFile(path, { req, ...opts })`);
  }
  if (usage.cookie) {
    props.push(`cookie: __cookieJar`);
  }
  if (usage.proxy) {
    helpers.markCore("proxyRequest");
    props.push(`proxy: (target, opts) => proxyRequest(target, { req, ...opts })`);
  }
  if (usage.forward) {
    helpers.markCore("forwardRequest");
    props.push(`forward: (target, opts) => forwardRequest(req, target, opts)`);
  }

  return props;
};

/** Emit the full-context prelude (context creation + global pre-hooks). */
export const buildFullContextPrelude = (
  route: RouteIR,
  helpers: Emitter,
  sync = false,
  resumeName = "",
): string[] => {
  helpers.markCore("runHooks");
  helpers.markCore("createContext");
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
    const __r = runHooks(__preParseStages, ctx);
    if (__r instanceof Promise) return ${resumeName}(ctx, undefined, 1, __r);
    const __globalPre = __r;
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
    const __r = runHooks(__preParseStages, ctx);
    const __globalPre = __r instanceof Promise ? await __r : __r;
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
  helpers: Emitter,
): { pre: string[]; callExpr: string } => {
  const { hasParamsValidator, hasQueryValidator, hasHeadersValidator, hasBodyValidator } =
    validationFlags(route);

  const pre: string[] = [];

  pre.push(`const __params = params ?? EMPTY_PARAMS;`);

  if (hasParamsValidator) {
    helpers.markUsed("validationError");
    pre.push(emitValidatorThrow(validatorImportName(route, "params"), "params", "__params"));
  }

  const needUrl = route.analysis.usage.url || (route.analysis.usage.query && !hasQueryValidator);

  if (needUrl) {
    pre.push(`const url = new URL(req.url);`);
  }

  if (route.analysis.usage.query || hasQueryValidator) {
    if (hasQueryValidator) {
      helpers.markUsed("validationError");
      helpers.markCore("parseQueryFromURL");
      pre.push(`const query = parseQueryFromURL(req.url);`);
      pre.push(emitValidatorThrow(validatorImportName(route, "query"), "query", "query"));
    } else {
      pre.push(`const query = url.searchParams;`);
    }
  }

  if (route.analysis.usage.headers || hasHeadersValidator) {
    if (hasHeadersValidator) {
      helpers.markUsed("validationError");
      pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);
      pre.push(emitValidatorThrow(validatorImportName(route, "headers"), "headers", "__headers"));
    }
  }

  if (route.analysis.usage.body || hasBodyValidator) {
    helpers.markCore("createLazyBody");

    if (hasBodyValidator) {
      helpers.markUsed("validationError");
    }

    pre.push(`let body = createLazyBody(req, BODY_LIMITS);`);

    if (hasBodyValidator) {
      pre.push(`const __body = await body.json();`);
      pre.push(emitValidatorThrow(validatorImportName(route, "body"), "body", "__body"));
      pre.push(`body.json = async () => __body;`);
    }
  }

  if (route.analysis.usage.state) {
    pre.push(`const state = new Map();`);
  }

  if (route.analysis.usage.set || route.analysis.usage.cookie) {
    pre.push(`const __set = { headers: Object.create(null), cookie: Object.create(null) };`);
  } else {
    pre.push(`const __set = __EMPTY_SET;`);
  }

  if (route.analysis.usage.cookie) {
    // Lazy jar: the Cookie header is parsed on first read (cached), so a
    // handler reading a single cookie does not pay for eagerly parsing the
    // full header up front (the old `createCookieJar(__set, {}, …)` path also
    // passed parsed cookies as `initial`, so values were never exposed).
    helpers.markCore("createLazyCookieJar");
    pre.push(`const __cookieJar = createLazyCookieJar(__set, () => req.headers.get("cookie"));`);
  }

  const props = buildContextProps(route, helpers);

  return {
    pre,
    callExpr:
      props.length === 0
        ? `${handlerImportName(route)}({})`
        : `${handlerImportName(route)}({ ${props.join(", ")} })`,
  };
};
