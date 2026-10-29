/**
 * @fileoverview Table-driven domain-error → HTTP mapping.
 *
 * Applications consistently repeat the same adapter in every module:
 *
 * ```ts
 * if (error instanceof ThingError) {
 *   const status = error.code === "NOT_FOUND" ? 404 : 422;
 *   return new RequestError(status, error.message, `THING_${error.code}`);
 * }
 * return error as Error;
 * ```
 *
 * {@link createErrorMapper} expresses that as data (rules) so the status
 * table, code prefix and fallback live in one place per module, and any
 * non-Error throw is normalised instead of leaking as a non-Error.
 */

import { RequestError } from "./http-errors";

/** The minimum shape a domain error needs to be mapped. */
export interface CodedError {
  readonly code: string;
  readonly message: string;
}

/** A domain-error constructor (abstract so `instanceof` narrowing works). */
export type CodedErrorClass = abstract new (...args: never[]) => CodedError;

/** One error family → HTTP rule. Rules are evaluated in array order. */
export interface HttpErrorRule {
  /** Constructor(s) matched with `instanceof`; a match consumes the error. */
  readonly errorClass: CodedErrorClass | readonly CodedErrorClass[];
  /** `error.code` → HTTP status. Unlisted codes use {@link fallbackStatus}. */
  readonly statuses?: Readonly<Record<string, number>>;
  /** Status for a code not present in {@link statuses} (default `400`). */
  readonly fallbackStatus?: number;
  /** Client code prefix: `PREFIX_CODE`. */
  readonly codePrefix?: string;
  /** Fixed client code, ignoring `error.code` entirely. */
  readonly code?: string;
  /** Per-code client-code overrides (wins over `codePrefix`, loses to `code`). */
  readonly codes?: Readonly<Record<string, string>>;
  /** Per-code message overrides (default: the domain message verbatim). */
  readonly messages?: Readonly<Record<string, string>>;
}

/** Options for {@link createErrorMapper}. */
export interface ErrorMapperOptions {
  /** Normalise an unmatched throw (default {@link asError}). */
  readonly passthrough?: (error: unknown) => Error;
}

/**
 * Normalise any thrown value to an `Error`.
 *
 * Route/server boundaries can receive non-Error throws (strings, objects);
 * `error as Error` is a lie that later loses `.message`/`.stack`.
 */
export const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Build a `(error) => Error` mapper from ordered {@link HttpErrorRule}s.
 *
 * A matched rule returns a {@link RequestError} carrying the mapped status,
 * the domain message, and either the fixed `code` or `` `${codePrefix}_${code}` ``.
 * An unmatched throw is passed through (normalised to an `Error`) so framework
 * errors such as 404s from elsewhere keep their status.
 *
 * @param rules - Error families to recognise, in match order.
 * @param options - Optional passthrough override.
 * @returns A mapper suitable for a route adapter's `catch` block.
 */
export function createErrorMapper(
  rules: readonly HttpErrorRule[],
  options: ErrorMapperOptions = {},
): (error: unknown) => Error {
  const passthrough = options.passthrough ?? asError;
  const normalised = rules.map((rule) => ({
    rule,
    classes: Array.isArray(rule.errorClass) ? rule.errorClass : [rule.errorClass],
  }));

  return (error: unknown): Error => {
    if (error !== null && typeof error === "object") {
      for (const { rule, classes } of normalised) {
        if (!classes.some((ctor) => error instanceof ctor)) continue;
        const coded = error as CodedError;
        const status = rule.statuses?.[coded.code] ?? rule.fallbackStatus ?? 400;
        const code =
          rule.code ??
          rule.codes?.[coded.code] ??
          (rule.codePrefix ? `${rule.codePrefix}_${coded.code}` : coded.code);
        const message = rule.messages?.[coded.code] ?? coded.message;
        return new RequestError(status, message, code);
      }
    }
    return passthrough(error);
  };
}
