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

/**
 * Emit the full-context validation block (params/query/headers/cookie/body),
 * marking the generated helpers each part needs. Returns the prelude lines
 * that the caller appends before the handler call.
 */
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

  const pre: string[] = [];

  if (route.analysis.hasValidation || hasAnyValidator) {
    helpers.markUsed("__schemaFor");
    helpers.markUsed("__validatePart");
    helpers.markCore("parseQueryFromURL");

    if (hasAnyValidator) {
      helpers.markUsed("validationError");
    }

    if (hasCookieValidator || opts.validateCookies !== false) {
      helpers.markCore("parseCookieString");
    }

    pre.push(
      `const __schema = ${
        route.analysis.hasValidation
          ? `__schemaFor(schema_${route.codegen.handlerRef})`
          : `undefined`
      };`,
    );

    // Params
    if (hasParamsValidator) {
      pre.push(`if (!${validatorImportName(route, "params")}(ctx.params)) {
  throw validationError(${validatorImportName(route, "params")}.errors ?? {}, "params");
}`);
    } else {
      pre.push(`await __validatePart(__schema?.params, ctx.params, "params");`);
    }

    // Query
    pre.push(`const __query = parseQueryFromURL(req.url);`);

    if (hasQueryValidator) {
      pre.push(`if (!${validatorImportName(route, "query")}(__query)) {
  throw validationError(${validatorImportName(route, "query")}.errors ?? {}, "query");
}`);
    } else {
      pre.push(`await __validatePart(__schema?.query, __query, "query");`);
    }

    pre.push(`Object.defineProperty(ctx, "query", { value: __query, configurable: true });`);

    // Headers
    pre.push(`const __headers = Object.fromEntries(req.headers.entries());`);

    if (hasHeadersValidator) {
      pre.push(`if (!${validatorImportName(route, "headers")}(__headers)) {
  throw validationError(${validatorImportName(route, "headers")}.errors ?? {}, "headers");
}`);
    } else {
      pre.push(`await __validatePart(__schema?.headers, __headers, "headers");`);
    }

    // Cookies
    if (hasCookieValidator || opts.validateCookies !== false) {
      pre.push(`const __cookies = parseCookieString(req.headers.get("cookie"));`);

      if (hasCookieValidator) {
        pre.push(`if (!${validatorImportName(route, "cookie")}(__cookies)) {
  throw validationError(${validatorImportName(route, "cookie")}.errors ?? {}, "cookie");
}`);
      } else {
        pre.push(`await __validatePart(__schema?.cookie, __cookies, "cookie");`);
      }
    }

    // Body
    if (hasBodyValidator) {
      pre.push(`const __body = await ctx.body.json();`);
      pre.push(`if (!${validatorImportName(route, "body")}(__body)) {
  throw validationError(${validatorImportName(route, "body")}.errors ?? {}, "body");
}`);
      pre.push(`ctx.body.json = async () => __body;`);
    } else {
      pre.push(`if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && __schema?.body) {
  const __body = await ctx.body.json();
  await __validatePart(__schema.body, __body, "body");
  ctx.body.json = async () => __body;
}`);
    }
  }

  return pre;
};
