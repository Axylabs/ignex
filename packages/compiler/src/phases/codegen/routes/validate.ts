/**
 * @fileoverview Codegen: per-part validation prelude emission (full context).
 */

import type { CompilerOptions, RouteIR } from "../../../types";
import { validatorImportName } from "../identifiers";

export interface ValidationFlags {
  readonly hasParamsValidator: boolean;
  readonly hasQueryValidator: boolean;
  readonly hasHeadersValidator: boolean;
  readonly hasBodyValidator: boolean;
  readonly hasCookieValidator: boolean;
  /** True when any of the five per-part validators is present. */
  readonly any: boolean;
}

/** Which per-part validators a route carries (from its codegen decisions). */
export const validationFlags = (route: RouteIR): ValidationFlags => {
  const flags = {
    hasParamsValidator: !!route.decisions.validators?.params,
    hasQueryValidator: !!route.decisions.validators?.query,
    hasHeadersValidator: !!route.decisions.validators?.headers,
    hasBodyValidator: !!route.decisions.validators?.body,
    hasCookieValidator: !!route.decisions.validators?.cookie,
  };
  return { ...flags, any: Object.values(flags).some(Boolean) };
};

type PartKind = "params" | "query" | "headers" | "cookie" | "body";

/**
 * Emit a precompiled-validator guard + `validationError` throw. Single source
 * for the emitted throw — shared by the full-context, specialized-context and
 * native validation preludes so the generated guard can't drift.
 */
export const emitValidatorThrow = (name: string, kind: string, valueExpr: string): string =>
  `if (!${name}(${valueExpr})) {
  throw validationError(${name}.errors ?? {}, "${kind}");
}`;

/** Lines for a part with a precompiled validator vs runtime `__validatePart`. */
const emitValidatorOrRuntime = (
  route: RouteIR,
  kind: PartKind,
  valueExpr: string,
  schemaExpr: string,
): string[] => {
  const name = validatorImportName(route, kind);
  if (route.decisions.validators?.[kind]) {
    return [emitValidatorThrow(name, kind, valueExpr)];
  }
  return [`await __validatePart(${schemaExpr}, ${valueExpr}, "${kind}");`];
};

/** Params — validated only when a params validator/schema part exists. */
export const emitParamsPrelude = (
  route: RouteIR,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (!hasValidator && !hasPart) return [];
  return emitValidatorOrRuntime(route, "params", "ctx.params", "__schema?.params");
};

/**
 * Query — parsed + exposed as a plain object ONLY when validated or declared
 * in the schema. Without a `query` schema the handler keeps the standard
 * `URLSearchParams` contract (`ctx.query.get(...)`, iteration) that the
 * interpreted router and the usage-specialized tier both provide; shadowing it
 * with a grouped Record here made `.get()` throw in compiled builds only.
 */
const emitQueryPrelude = (
  route: RouteIR,
  usedCore: Set<string>,
  hasValidator: boolean,
  querySchema: boolean | undefined,
): string[] => {
  // `querySchema === false` is a statically-proven "no query schema": keep the
  // URLSearchParams getter untouched. `undefined` means the schema shape was
  // not statically readable — parse/validate conservatively, then decide the
  // shadow from the runtime schema object.
  if (!hasValidator && querySchema === false) return [];
  usedCore.add("parseQueryFromURL");
  const lines = [`const __query = parseQueryFromURL(req.url);`];

  if (hasValidator) {
    lines.push(emitValidatorThrow(validatorImportName(route, "query"), "query", "__query"));
  } else if (querySchema !== false) {
    // Runtime validation only when a query schema actually exists.
    lines.push(`await __validatePart(__schema?.query, __query, "query");`);
  }

  // Shadow `ctx.query` with the parsed Record via the context's `query`
  // setter — a plain assignment is ~8x faster than the old per-request
  // `Object.defineProperty` (which forced a hidden-class transition on a fresh
  // instance). Only a route that actually HAS a query schema gets the Record;
  // otherwise the lazy URLSearchParams getter stays (stable `.get()` contract).
  lines.push(
    hasValidator || querySchema === true
      ? `ctx.query = __query;`
      : `if (__schema?.query !== undefined) ctx.query = __query;`,
  );
  return lines;
};

/** Headers — materialized ONLY when headers are validated. */
export const emitHeadersPrelude = (
  route: RouteIR,
  usedCore: Set<string>,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (!hasValidator && !hasPart) return [];
  usedCore.add("headersToRecord");
  const lines = [`const __headers = headersToRecord(req.headers);`];
  lines.push(...emitValidatorOrRuntime(route, "headers", "__headers", "__schema?.headers"));
  return lines;
};

/**
 * Cookies — parsed ONLY when validated or read by the handler. A route that
 * neither validates nor reads cookies pays nothing.
 */
const emitCookiesPrelude = (
  route: RouteIR,
  usedCore: Set<string>,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (!hasValidator && !hasPart && !route.analysis.usage.cookie) return [];
  usedCore.add("parseCookieString");
  const lines = [`const __cookies = parseCookieString(req.headers.get("cookie"));`];

  if (hasValidator) {
    lines.push(emitValidatorThrow(validatorImportName(route, "cookie"), "cookie", "__cookies"));
  } else if (hasPart) {
    lines.push(`await __validatePart(__schema?.cookie, __cookies, "cookie");`);
  }

  // Seed the lazy ctx.cookie jar with the header already parsed above so a
  // handler reading cookies does not re-parse the Cookie header.
  if (route.analysis.usage.cookie) {
    usedCore.add("createLazyCookieJar");
    lines.push(
      `ctx.cookie = createLazyCookieJar(ctx.set, () => req.headers.get("cookie"), undefined, __cookies);`,
    );
  }
  return lines;
};

/** Body — precompiled validator, or guarded runtime parse for schema parts. */
export const emitBodyPrelude = (
  route: RouteIR,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (hasValidator) {
    const name = validatorImportName(route, "body");
    return [
      `const __body = await ctx.body.json();`,
      emitValidatorThrow(name, "body", "__body"),
      `ctx.body.json = async () => __body;`,
    ];
  }
  if (!hasPart) return [];
  return [
    `if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && __schema?.body) {
  const __body = await ctx.body.json();
  await __validatePart(__schema.body, __body, "body");
  ctx.body.json = async () => __body;
}`,
  ];
};

/**
 * Emit the full-context validation block (params/query/headers/cookie/body).
 * Returns the prelude lines that the caller appends before the handler call.
 *
 * Usage-driven: each part is parsed AND validated ONLY when it is actually
 * validated (precompiled validator or a schema part) or consumed by the
 * handler (`usage`). A body-only schema route no longer parses the query
 * string, walks request headers, or splits the Cookie header on every request
 * — that was the single biggest redundant cost on validated routes.
 */
/** Emit the shared `__schema` const consumed by the runtime `__validatePart`. */
export const emitSchemaConst = (route: RouteIR): string => {
  // Named-export routes attach the schema to the handler export
  // (`httpGet.schema`), not to the namespace's `default` — tell `__schemaFor`
  // which binding to fall back to so runtime validation isn't silently skipped
  // when precompiled validators are off.
  const named = route.analysis.handlerExportName;
  const arg = named ? `, ${JSON.stringify(named)}` : "";
  return `const __schema = ${
    route.analysis.hasValidation
      ? `__schemaFor(schema_${route.codegen.handlerRef}${arg})`
      : `undefined`
  };`;
};

export const emitFullValidationPrelude = (
  route: RouteIR,
  opts: CompilerOptions,
  usedCore: Set<string>,
): string[] => {
  const {
    any: hasAnyValidator,
    hasParamsValidator,
    hasQueryValidator,
    hasHeadersValidator,
    hasBodyValidator,
    hasCookieValidator,
  } = validationFlags(route);

  if (!(route.analysis.hasValidation || hasAnyValidator)) return [];

  // Per-part schemas resolved by the precompile phase. When available
  // (precompileValidators on — the default) we know EXACTLY which parts exist
  // and emit only those; when precompilation did not run, fall back to the
  // schema object literal's statically-readable keys. Only when neither is
  // known do we stay conservative (validate every part).
  const schemaDoc = route.decisions.schemaDoc as Record<string, unknown> | undefined;
  const schemaParts = route.analysis.schemaParts;
  /** `true`/`false` when statically known, `undefined` when the shape is opaque. */
  const schemaPartOf = (kind: string): boolean | undefined => {
    if (schemaDoc !== undefined) return schemaDoc[kind] !== undefined;
    if (schemaParts !== undefined) return schemaParts.includes(kind);
    return undefined;
  };
  const hasSchemaPart = (kind: string): boolean => schemaPartOf(kind) ?? true;

  const pre: string[] = [emitSchemaConst(route)];

  pre.push(...emitParamsPrelude(route, hasParamsValidator, hasSchemaPart("params")));
  pre.push(...emitQueryPrelude(route, usedCore, hasQueryValidator, hasSchemaPart("query")));
  pre.push(...emitHeadersPrelude(route, usedCore, hasHeadersValidator, hasSchemaPart("headers")));
  if (opts.validateCookies !== false) {
    pre.push(...emitCookiesPrelude(route, usedCore, hasCookieValidator, hasSchemaPart("cookie")));
  }
  pre.push(...emitBodyPrelude(route, hasBodyValidator, hasSchemaPart("body")));

  return pre;
};
