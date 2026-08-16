/**
 * @fileoverview Codegen: per-route native prelude (opt-in `nativeRoutes`).
 *
 * For full-context routes that parse/validate query or cookies, the compiler
 * emits a pre-baked native stack — `createNativeRoute({ pipeline: [...] })` —
 * that parses them in ONE C-ABI call (the queryPairs x0.28 / cookiePairs
 * x0.105 wrapper overhead), seeding `ctx.query` / `ctx.cookie` byte-identically
 * to the JS prelude.
 *
 * The plan enables ONLY the stages the route needs (features on/off) and lists
 * them in the exact order the compiled JS prelude runs them — so the addon
 * pre-bakes the minimal fixed function stack (see route-wire.ts `NativeRoutePlan`
 * and castrum `rust/route.rs`). When the addon lacks the route surface
 * (`createNativeRoute` → null) or a native run fails, the core fn falls back to
 * the existing JS prelude — byte-parity preserved.
 */

import type { Emitter } from "../../../emitter";
import type { CompilerOptions, RouteIR } from "../../../types";
import { nativeRouteVar, validatorImportName } from "../identifiers";
import type { CodegenState } from "../state";
import {
  emitBodyPrelude,
  emitFullValidationPrelude,
  emitHeadersPrelude,
  emitParamsPrelude,
  emitSchemaConst,
  emitValidatorThrow,
  markValidationPreludeHelpers,
  type ValidationFlags,
  validationFlags,
} from "./validate";

/** Which query/cookie/body stages a route needs (drives the emitted pipeline). */
interface RouteNativeNeeds {
  readonly needsQuery: boolean;
  readonly needsCookie: boolean;
  /** Body is validated on raw bytes AND the handler never reads it (ack). */
  readonly needsBody: boolean;
}

const schemaDocOf = (route: RouteIR): Record<string, unknown> | undefined =>
  route.decisions.schemaDoc as Record<string, unknown> | undefined;

/** Per-part schema presence (conservative `true` when precompilation is off). */
const hasSchemaPart =
  (route: RouteIR) =>
  (kind: string): boolean => {
    const doc = schemaDocOf(route);
    return doc !== undefined ? doc[kind] !== undefined : true;
  };

const routeNativeNeeds = (
  route: RouteIR,
  opts: CompilerOptions,
  flags: ValidationFlags,
  hasPart: (kind: string) => boolean,
): RouteNativeNeeds => {
  // Body validation is native-eligible ONLY when the body schema is known AND
  // the handler never reads the body — then a raw-bytes verdict is the whole
  // job (no JSON.parse, no Ajv, no ctx.body object). Handlers that read the
  // body keep the JS path (they need the parsed value anyway).
  const bodySchema = schemaDocOf(route)?.body;
  return {
    needsQuery: flags.hasQueryValidator || hasPart("query") || route.analysis.usage.query,
    needsCookie:
      opts.validateCookies !== false &&
      (flags.hasCookieValidator || hasPart("cookie") || route.analysis.usage.cookie),
    needsBody:
      bodySchema !== undefined &&
      (flags.hasBodyValidator || hasPart("body")) &&
      route.analysis.usage.body === false,
  };
};

/**
 * True when this route should get a native prelude: `nativeRoutes` is on, the
 * validation prelude would actually fire (schema export or a precompiled
 * validator), and the route parses query/cookies or validates an unread body.
 */
export const nativeRouteEligible = (route: RouteIR, opts: CompilerOptions): boolean => {
  if (!opts.nativeRoutes) return false;
  const flags = validationFlags(route);
  if (!(route.analysis.hasValidation || flags.any)) return false;
  const { needsQuery, needsCookie, needsBody } = routeNativeNeeds(
    route,
    opts,
    flags,
    hasSchemaPart(route),
  );
  return needsQuery || needsCookie || needsBody;
};

/**
 * The `createNativeRoute` plan literal — features on/off as a pipeline, the
 * per-part schemas (Phase 2 compiles the body schema into the stack for
 * raw-bytes `validateBody` / `requireJsonBody`), and the limits.
 */
const buildNativeRoutePlan = (route: RouteIR, opts: CompilerOptions): string => {
  const flags = validationFlags(route);
  const { needsQuery, needsCookie, needsBody } = routeNativeNeeds(
    route,
    opts,
    flags,
    hasSchemaPart(route),
  );
  const pipeline = [
    ...(needsQuery ? (["parseQuery"] as const) : []),
    ...(needsCookie ? (["parseCookies"] as const) : []),
    ...(needsBody ? (["requireJsonBody", "validateBody"] as const) : []),
  ];
  const parts: string[] = [
    `pipeline: ${JSON.stringify(pipeline)}`,
    needsBody
      ? // Encode the draft-07 body schema once, at module init. `new
        // TextEncoder().encode(<string literal>)` — the double-stringified
        // JSON is a valid JS string literal.
        `schemas: { body: new TextEncoder().encode(${JSON.stringify(
          JSON.stringify(schemaDocOf(route)?.body ?? {}),
        )}) }`
      : `schemas: {}`,
    `maxBodyBytes: ${opts.maxJsonBytes ?? 2 * 1024 * 1024}`,
    `maxQueryBytes: ${1024 * 1024}`,
    `maxCookieBytes: ${8192}`,
    `maxPairs: ${0}`,
  ];
  return `{ ${parts.join(", ")} }`;
};

/**
 * Emit the module-level `const __nativeRoute_<ref> = createNativeRoute({...})`
 * (null at runtime when the addon lacks the route surface) + mark the core
 * import. Called once per eligible route in the codegen header section.
 */
export const emitNativeRouteVar = (
  state: CodegenState,
  route: RouteIR,
  opts: CompilerOptions,
): void => {
  state.header.push(
    `const ${nativeRouteVar(route)} = createNativeRoute(${buildNativeRoutePlan(route, opts)});`,
  );
  state.helpers.markCore("createNativeRoute");
};

/** Query validation + `ctx.query` seeding on the already-parsed `__query`. */
const emitNativeQueryValidation = (
  route: RouteIR,
  flags: ValidationFlags,
  hasPart: (kind: string) => boolean,
): string[] => {
  const name = validatorImportName(route, "query");
  const lines: string[] = [];
  if (flags.hasQueryValidator) {
    lines.push(emitValidatorThrow(name, "query", "__query"));
  } else if (hasPart("query")) {
    lines.push(`await __validatePart(__schema?.query, __query, "query");`);
  }
  lines.push(`ctx.query = __query;`);
  return lines;
};

/** Cookie validation + `ctx.cookie` jar seeding on the already-parsed `__cookies`. */
const emitNativeCookieValidation = (
  route: RouteIR,
  flags: ValidationFlags,
  hasPart: (kind: string) => boolean,
): string[] => {
  const name = validatorImportName(route, "cookie");
  const lines: string[] = [];
  if (flags.hasCookieValidator) {
    lines.push(emitValidatorThrow(name, "cookie", "__cookies"));
  } else if (hasPart("cookie")) {
    lines.push(`await __validatePart(__schema?.cookie, __cookies, "cookie");`);
  }
  if (route.analysis.usage.cookie) {
    lines.push(
      `ctx.cookie = createLazyCookieJar(ctx.set, () => req.headers.get("cookie"), undefined, __cookies);`,
    );
  }
  return lines;
};

/**
 * Emit the full-context validation prelude with a native-first query/cookie
 * parse and a JS fallback, preserving the exact JS part order
 * (params → query → headers → cookie → body) and thus validation precedence.
 *
 * Structure:
 *   const __native = __nativeRoute_<ref>;          // null when addon lacks it
 *   if (__native) { run once; __query = groupQueryPairs(__nr.query); … }
 *   if (__query === undefined)  { __query = parseQueryFromURL(req.url); }   // JS fallback
 *   if (__cookies === undefined) { __cookies = parseCookieString(...); }
 *   <params | query-validate | headers | cookie-validate | body>  (shared JS)
 *
 * Falls back to `emitFullValidationPrelude` for ineligible routes.
 */
export const emitNativeValidationPrelude = (
  route: RouteIR,
  opts: CompilerOptions,
  helpers: Emitter,
): string[] => {
  if (!nativeRouteEligible(route, opts)) {
    return emitFullValidationPrelude(route, opts, helpers);
  }

  const flags = validationFlags(route);
  const hasPart = hasSchemaPart(route);
  const { needsQuery, needsCookie, needsBody } = routeNativeNeeds(route, opts, flags, hasPart);

  markValidationPreludeHelpers(route, flags.any, helpers, hasPart);
  helpers.markCore("createNativeRoute");
  if (needsQuery) {
    helpers.markCore("groupQueryPairs");
    helpers.markCore("parseQueryFromURL");
  }
  if (needsCookie) {
    helpers.markCore("cookiePairsToRecord");
    helpers.markCore("parseCookieString");
  }
  if (needsBody) {
    // The native 422 path throws `validationError`, the 400 path throws
    // `BodyParseError` (both core/generated imports).
    helpers.markUsed("validationError");
    helpers.markCore("BodyParseError");
  }
  if (route.analysis.usage.cookie) helpers.markCore("createLazyCookieJar");

  const pre: string[] = [emitSchemaConst(route)];
  if (needsQuery) pre.push(`let __query;`);
  if (needsCookie) pre.push(`let __cookies;`);
  if (needsBody) pre.push(`let __bodyValidated = false;`);
  pre.push(...emitNativeRunBlock(route, flags, needsQuery, needsCookie, needsBody));
  if (needsQuery) {
    pre.push(`if (__query === undefined) {`);
    pre.push(`  __query = parseQueryFromURL(req.url);`);
    pre.push(`}`);
  }
  if (needsCookie) {
    pre.push(`if (__cookies === undefined) {`);
    pre.push(`  __cookies = parseCookieString(req.headers.get("cookie"));`);
    pre.push(`}`);
  }
  pre.push(...emitParamsPrelude(route, flags.hasParamsValidator, hasPart("params")));
  if (needsQuery) pre.push(...emitNativeQueryValidation(route, flags, hasPart));
  pre.push(...emitHeadersPrelude(route, flags.hasHeadersValidator, hasPart("headers")));
  if (needsCookie) pre.push(...emitNativeCookieValidation(route, flags, hasPart));
  if (needsBody) {
    // Native validated the body and the handler never reads it → skip the JS
    // parse entirely. When native was unavailable/failed, run the JS body
    // prelude (byte-parity fallback).
    pre.push(`if (!__bodyValidated) {`);
    pre.push(...emitBodyPrelude(route, flags.hasBodyValidator, hasPart("body")));
    pre.push(`}`);
  } else {
    pre.push(...emitBodyPrelude(route, flags.hasBodyValidator, hasPart("body")));
  }

  return pre;
};

/**
 * The `if (__native) { … }` block: pack the frame (raw body bytes pass through
 * zero-copy), run the pre-baked stack once, seed query/cookie records on
 * success, and — for body-validating routes — throw on a native body verdict
 * (400 = not valid JSON, 422 = failed its schema) BEFORE any JS parse. A
 * failed/thrown native run leaves everything undefined so the JS prelude
 * below remains the parity fallback.
 *
 * Runtime body-schema routes skip body work on GET/HEAD/OPTIONS — exactly
 * matching the `emitBodyPrelude` guard (a precompiled body validator always
 * parses, so its routes get no method guard).
 */
const emitNativeRunBlock = (
  route: RouteIR,
  flags: ValidationFlags,
  needsQuery: boolean,
  needsCookie: boolean,
  needsBody: boolean,
): string[] => {
  const out: string[] = [];
  const bodyGuard =
    needsBody && !flags.hasBodyValidator
      ? `req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"`
      : null;

  out.push(`const __native = ${nativeRouteVar(route)};`);
  out.push(`if (__native) {`);
  out.push(`  const __qIdx = req.url.indexOf("?");`);
  out.push(`  let __nr;`);
  if (needsBody) {
    out.push(
      `  const __bodyBytes = ${
        bodyGuard
          ? `${bodyGuard} ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0)`
          : `new Uint8Array(await req.arrayBuffer())`
      };`,
    );
  }
  out.push(`  try {`);
  out.push(`    __nr = __native.run({`);
  out.push(`      query: __qIdx < 0 ? "" : req.url.slice(__qIdx + 1),`);
  out.push(`      cookie: req.headers.get("cookie") ?? "",`);
  out.push(`      body: ${needsBody ? "__bodyBytes" : "null"},`);
  out.push(`    });`);
  out.push(`  } catch {`);
  out.push(`    __nr = null;`);
  out.push(`  }`);
  out.push(`  if (__nr) {`);
  if (needsBody) {
    // First-failure-wins: 400 = not valid JSON, 422 = failed its schema.
    out.push(`    ${bodyGuard ? `if (${bodyGuard}) {` : "if (true) {"}`);
    out.push(`      if (!__nr.ok) {`);
    out.push(`        if (__nr.errorCode === 400) {`);
    out.push(`          throw new BodyParseError("Invalid JSON body");`);
    out.push(`        }`);
    out.push(`        if (__nr.errorCode === 422) {`);
    out.push(`          throw validationError(__schema?.body ?? {}, "body");`);
    out.push(`        }`);
    out.push(`      }`);
    out.push(`    }`);
  }
  out.push(`    if (__nr.ok) {`);
  if (needsQuery) out.push(`      __query = groupQueryPairs(__nr.query);`);
  if (needsCookie) out.push(`      __cookies = cookiePairsToRecord(__nr.cookie);`);
  if (needsBody) {
    out.push(
      `      ${bodyGuard ? `if (${bodyGuard}) { __bodyValidated = true; }` : "__bodyValidated = true;"}`,
    );
  }
  out.push(`    }`);
  out.push(`  }`);
  out.push(`}`);
  return out;
};
