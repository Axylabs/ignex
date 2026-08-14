/**
 * @fileoverview Codegen: per-part validation prelude emission (full context).
 */

import type { Emitter } from "../../../emitter";
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

/** The five validate-able schema parts, in emission order. */
const PART_KINDS = ["params", "query", "headers", "cookie", "body"] as const;

type PartKind = (typeof PART_KINDS)[number];

/** Lines for a part with a precompiled validator vs runtime `__validatePart`. */
const emitValidatorOrRuntime = (
  route: RouteIR,
  kind: PartKind,
  valueExpr: string,
  schemaExpr: string,
): string[] => {
  const name = validatorImportName(route, kind);
  if (route.decisions.validators?.[kind]) {
    return [
      `if (!${name}(${valueExpr})) {
  throw validationError(${name}.errors ?? {}, "${kind}");
}`,
    ];
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
 * Query — parsed + exposed as a plain object ONLY when validated or read by
 * the handler (`usage.query`). Unvalidated, unused full-context routes keep
 * the fast Bun-native `url.searchParams` (`ctx.query` getter) instead of the
 * ~10x slower JS split parser. A usage-only part (no query schema) is parsed
 * to restore the Record-shaped `ctx.query` the full-context design promises,
 * but skips the (wasted) runtime `__validatePart` await.
 */
const emitQueryPrelude = (
  route: RouteIR,
  helpers: Emitter,
  hasValidator: boolean,
  hasPart: boolean,
  usageQuery: boolean,
): string[] => {
  if (!hasValidator && !hasPart && !usageQuery) return [];
  helpers.markCore("parseQueryFromURL");
  const lines = [`const __query = parseQueryFromURL(req.url);`];

  if (hasValidator) {
    const name = validatorImportName(route, "query");
    lines.push(`if (!${name}(__query)) {
  throw validationError(${name}.errors ?? {}, "query");
}`);
  } else if (hasPart) {
    // Runtime validation only when a query schema actually exists.
    lines.push(`await __validatePart(__schema?.query, __query, "query");`);
  }

  // Shadow `ctx.query` with the parsed Record via the context's `query`
  // setter — a plain assignment is ~8x faster than the old per-request
  // `Object.defineProperty` (which forced a hidden-class transition on a fresh
  // instance). Observable reads are identical.
  lines.push(`ctx.query = __query;`);
  return lines;
};

/** Headers — materialized ONLY when headers are validated. */
export const emitHeadersPrelude = (
  route: RouteIR,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (!hasValidator && !hasPart) return [];
  const lines = [`const __headers = Object.fromEntries(req.headers.entries());`];
  lines.push(...emitValidatorOrRuntime(route, "headers", "__headers", "__schema?.headers"));
  return lines;
};

/**
 * Cookies — parsed ONLY when validated or read by the handler. A route that
 * neither validates nor reads cookies pays nothing.
 */
const emitCookiesPrelude = (
  route: RouteIR,
  helpers: Emitter,
  hasValidator: boolean,
  hasPart: boolean,
): string[] => {
  if (!hasValidator && !hasPart && !route.analysis.usage.cookie) return [];
  helpers.markCore("parseCookieString");
  const lines = [`const __cookies = parseCookieString(req.headers.get("cookie"));`];

  if (hasValidator) {
    const name = validatorImportName(route, "cookie");
    lines.push(`if (!${name}(__cookies)) {
  throw validationError(${name}.errors ?? {}, "cookie");
}`);
  } else if (hasPart) {
    lines.push(`await __validatePart(__schema?.cookie, __cookies, "cookie");`);
  }

  // Seed the lazy ctx.cookie jar with the header already parsed above so a
  // handler reading cookies does not re-parse the Cookie header.
  if (route.analysis.usage.cookie) {
    helpers.markCore("createLazyCookieJar");
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
      `if (!${name}(__body)) {
  throw validationError(${name}.errors ?? {}, "body");
}`,
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
 * Emit the full-context validation block (params/query/headers/cookie/body),
 * marking the generated helpers each part needs. Returns the prelude lines
 * that the caller appends before the handler call.
 *
 * Usage-driven: each part is parsed AND validated ONLY when it is actually
 * validated (precompiled validator or a schema part) or consumed by the
 * handler (`usage`). A body-only schema route no longer parses the query
 * string, walks request headers, or splits the Cookie header on every request
 * — that was the single biggest redundant cost on validated routes.
 */
/** Emit the shared `__schema` const consumed by the runtime `__validatePart`. */
export const emitSchemaConst = (route: RouteIR): string =>
  `const __schema = ${
    route.analysis.hasValidation ? `__schemaFor(schema_${route.codegen.handlerRef})` : `undefined`
  };`;

/**
 * Mark the shared validation-prelude helpers (`__schemaFor`,
 * `validationError`, `__validatePart`) used by the per-part emitters. Shared
 * by the plain JS prelude and the native-first prelude (`routes/native.ts`).
 */
export const markValidationPreludeHelpers = (
  route: RouteIR,
  hasAnyValidator: boolean,
  helpers: Emitter,
  hasSchemaPart: (kind: string) => boolean,
): void => {
  helpers.markUsed("__schemaFor");
  if (hasAnyValidator) helpers.markUsed("validationError");
  // Only mark `__validatePart` when at least one schema part has no
  // precompiled validator (keeps the generated helper set minimal).
  if (PART_KINDS.some((kind) => hasSchemaPart(kind) && !route.decisions.validators?.[kind])) {
    helpers.markUsed("__validatePart");
  }
};

export const emitFullValidationPrelude = (
  route: RouteIR,
  opts: CompilerOptions,
  helpers: Emitter,
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
  // and emit only those; when unknown (precompilation off) `hasSchemaPart`
  // stays conservative (true) so runtime `__validatePart` still runs for every
  // part — preserving the previous behavior.
  const schemaDoc = route.decisions.schemaDoc as Record<string, unknown> | undefined;
  const hasSchemaPart = (kind: string): boolean =>
    schemaDoc !== undefined ? schemaDoc[kind] !== undefined : true;

  markValidationPreludeHelpers(route, hasAnyValidator, helpers, hasSchemaPart);

  const pre: string[] = [emitSchemaConst(route)];

  pre.push(...emitParamsPrelude(route, hasParamsValidator, hasSchemaPart("params")));
  pre.push(
    ...emitQueryPrelude(
      route,
      helpers,
      hasQueryValidator,
      hasSchemaPart("query"),
      route.analysis.usage.query,
    ),
  );
  pre.push(...emitHeadersPrelude(route, hasHeadersValidator, hasSchemaPart("headers")));
  if (opts.validateCookies !== false) {
    pre.push(...emitCookiesPrelude(route, helpers, hasCookieValidator, hasSchemaPart("cookie")));
  }
  pre.push(...emitBodyPrelude(route, hasBodyValidator, hasSchemaPart("body")));

  return pre;
};
