/**
 * @fileoverview Shared fast-check arbitraries — "variety of data" generators
 * used by property-based suites across packages.
 *
 * Every arbitrary here is deliberately small and composable so tests read as
 * invariants over generated inputs rather than hand-picked vectors. Keep them
 * generic (no framework imports) so any package can use them without pulling
 * in @ignus/core etc.
 */

import * as fc from "fast-check";

/** Any JSON value (nested-safe, capped depth). Perfect for bodies/schemas. */
export const arbJsonValue: fc.Arbitrary<unknown> = fc.jsonValue({
  maxDepth: 4,
});

/** A JSON object with string keys and arbitrary JSON values. */
export const arbJsonObject: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.jsonValue(),
  { maxKeys: 8 },
);

/** A small, collision-prone array of JSON values (good for dedup/merge tests). */
export const arbJsonArray: fc.Arbitrary<unknown[]> = fc.array(arbJsonValue, { maxLength: 12 });

/** HTTP method vocabulary (must stay aligned with `@ignus/shared` HTTP_METHODS). */
export const arbHttpMethod = fc.constantFrom(
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
  "WS",
);

/** Build a string arbitrary from an allowed character set (fast-check v4). */
const stringFromChars = (
  chars: readonly string[],
  constraints: { minLength: number; maxLength: number },
): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...chars), constraints).map((parts) => parts.join(""));

/** A single RFC 3986 path segment (no slashes, safe for file-system routing). */
export const arbRouteSegment: fc.Arbitrary<string> = stringFromChars(
  "abcdefghijklmnopqrstuvwxyz0123456789-_.~".split(""),
  { minLength: 0, maxLength: 12 },
);

/**
 * A parameter name matching the `[name]` / `[...name]` file-routing rules
 * (lowercase letters/numbers/underscore).
 */
export const arbParamName: fc.Arbitrary<string> = stringFromChars(
  "abcdefghijklmnopqrstuvwxyz0123456789_".split(""),
  { minLength: 1, maxLength: 16 },
);

/**
 * A route path with a mix of static segments and `:param` / `*wildcard`
 * placeholders (the core OpenAPI + compiler path conventions).
 */
export const arbRoutePath: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      arbRouteSegment.filter((s) => s.length > 0).map((s) => `/${s}`),
      arbParamName.map((p) => `/:${p}`),
      arbParamName.map((p) => `/*${p}`),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((parts) => (parts.length ? parts.join("") : "/"));

/** An HTTP header field name (RFC 7230 token). */
export const arbHeaderName: fc.Arbitrary<string> = stringFromChars(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split(""),
  { minLength: 1, maxLength: 24 },
);

/** An HTTP header field value (printable ASCII, may be empty). */
export const arbHeaderValue: fc.Arbitrary<string> = stringFromChars(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ,;:/=@._-*()".split(""),
  { minLength: 0, maxLength: 64 },
);

/** A cookie name/value pair (no separators that would break serialization). */
export const arbCookiePair: fc.Arbitrary<[string, string]> = fc.tuple(
  arbParamName,
  stringFromChars("abcdefghijklmnopqrstuvwxyz0123456789-_.~".split(""), {
    minLength: 0,
    maxLength: 32,
  }),
);

/** A raw `key=value` query pair, value may be URL-encoded. */
export const arbQueryPair: fc.Arbitrary<[string, string]> = fc.tuple(
  arbParamName,
  stringFromChars("abcdefghijklmnopqrstuvwxyz0123456789-_.~%+".split(""), {
    minLength: 0,
    maxLength: 24,
  }),
);

/** A full query string starting with `?` or empty. */
export const arbQueryString: fc.Arbitrary<string> = fc
  .array(arbQueryPair, { minLength: 0, maxLength: 6 })
  .map((pairs) => (pairs.length ? `?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}` : ""));

/** Any valid 3-digit HTTP status code. */
export const arbStatusCode: fc.Arbitrary<number> = fc.integer({ min: 100, max: 599 });

/** A plausible Accept-Language q-value (`q=0`..`1`). */
export const arbQsValue: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 0.1, 0.5, 0.9, 1),
  fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
);

/**
 * A single Accept-Language entry: `lang`, optionally `-REGION`, optionally
 * with a `;q=` weight. Mirrors the `negotiateLocale` parser input space.
 */
export const arbLocaleEntry: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("en", "en", "fr", "de", "es", "pt", "zh", "ja", "ar", "hi", "xx", "x"),
    fc.constantFrom("", "-US", "-GB", "-FR", "-DE", "-BR", "-CN"),
    fc.boolean(),
    arbQsValue,
  )
  .map(([lang, region, weighted, weight]) => {
    const tag = `${lang}${region}`;
    return weighted ? `${tag};q=${weight}` : tag;
  });

/** A full Accept-Language header value (comma-joined entries). */
export const arbAcceptLanguageHeader: fc.Arbitrary<string> = fc
  .array(arbLocaleEntry, { minLength: 0, maxLength: 5 })
  .map((entries) => entries.join(", "));

/** A `{lang, quality}` pair for locale negotiation tests. */
export const arbLocaleQuality: fc.Arbitrary<[string, number]> = fc.tuple(
  fc.constantFrom("en", "en-US", "fr", "fr-FR", "de", "es", "pt-BR", "zh-CN", "ja"),
  arbQsValue,
);

/** A short lowercase identifier (package/route/field names). */
export const arbIdentifier: fc.Arbitrary<string> = stringFromChars(
  "abcdefghijklmnopqrstuvwxyz0123456789_".split(""),
  { minLength: 1, maxLength: 20 },
);
