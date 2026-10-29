/**
 * @fileoverview `defineError` — a domain error that already knows its HTTP
 * contract, so a module never writes a mapper.
 *
 * Before:
 *
 * ```ts
 * // service.ts
 * export class BillingError extends Error {
 *   constructor(message: string, readonly code: "NOT_FOUND" | "INVALID_STATE") { … }
 * }
 * // http-mapper.ts
 * export const mapBillingError = createErrorMapper([{ errorClass: BillingError, … }]);
 * // route.ts
 * try { … } catch (error) { throw mapBillingError(error); }
 * ```
 *
 * After:
 *
 * ```ts
 * export const BillingError = defineError("BillingError");
 * // route.ts — nothing: the boundary maps it.
 * ```
 *
 * The class produced by {@link defineError} extends the framework's
 * `HTTPError`, so `errorToResponse` (and therefore both the compiled and the
 * interpreted server) answers with the declared status/code/envelope with no
 * adapter in between. `createErrorMapper` remains for mapping *foreign* errors
 * you cannot change — third-party libraries, driver failures.
 */

import type { FaultOrigin } from "./fault-vocabulary";
import { HTTPError } from "./http-errors";

/**
 * Conventional status for the codes applications actually use.
 *
 * The table exists so the common case needs no configuration at all: a module
 * whose codes are `NOT_FOUND` / `FORBIDDEN` / `INVALID_STATE` declares nothing
 * and still answers 404 / 403 / 409. Anything domain-specific (`VENUE_CONFLICT`,
 * `QUOTA_EXCEEDED`, …) is a one-entry {@link DefineErrorOptions.codes} override.
 */
export const DOMAIN_CODE_STATUS = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  CONFLICT: 409,
  DUPLICATE: 409,
  ALREADY_EXISTS: 409,
  ALREADY_MEMBER: 409,
  ALREADY_ACCEPTED: 409,
  ALREADY_REDEEMED: 409,
  INVALID_INPUT: 422,
  INVALID_REQUEST: 422,
  INVALID_STATE: 409,
  INVALID_STATUS: 409,
  INVALID_TRANSITION: 409,
  GONE: 410,
  EXPIRED: 410,
  LOCKED: 423,
  ATTEMPTS_EXCEEDED: 429,
  RATE_LIMITED: 429,
  TOO_MANY_REQUESTS: 429,
} as const;

/** Options for {@link defineError}. Every field is optional. */
export interface DefineErrorOptions {
  /** Status per domain code; wins over {@link DOMAIN_CODE_STATUS}. */
  readonly codes?: Readonly<Record<string, number>>;
  /** Status for a code in neither map (default `400`). */
  readonly fallbackStatus?: number;
  /**
   * Client-code namespace: `` `${prefix}_${code}` `` on the wire. Unset by
   * default — the domain code IS the client code (`NOT_FOUND`), so a service
   * that branches on `error.code` keeps working. Opt in (`prefix: "BILLING"`)
   * when several modules share a code and clients need them distinguishable;
   * `error.domainCode` still carries the raw code.
   */
  readonly prefix?: string;
  /** Fixed client code for every domain code (wins over `prefix`). */
  readonly code?: string;
  /** Per-code client-code overrides (wins over `prefix`, loses to `code`). */
  readonly codeNames?: Readonly<Record<string, string>>;
  /** Per-code client message (default: the message passed to the constructor). */
  readonly messages?: Readonly<Record<string, string>>;
  /** Fault taxonomy origin used by reports (default `request`). */
  readonly origin?: FaultOrigin;
  /**
   * The code to use when the constructor is called without one. A single-code
   * error (`QrDesignError`) then reads `new QrDesignError("…")`; without it,
   * omitting the code is a programming error and throws.
   */
  readonly defaultCode?: string;
}

/** The instance shape every {@link defineError} class produces. */
export type DomainError<C extends string = string> = HTTPError & {
  /** The raw domain code (`NOT_FOUND`), before any HTTP prefixing. */
  readonly domainCode: C;
};

/** The constructor returned by {@link defineError}. */
export interface DomainErrorClass<C extends string = string> {
  new (message: string, code?: C, details?: Record<string, unknown>): DomainError<C>;
  /** The class name (also `error.name` on instances). */
  readonly errorName: string;
  /** The conventional + configured code → status map. */
  readonly statuses: Readonly<Record<string, number>>;
  /** Status for a code absent from {@link statuses}. */
  readonly fallbackStatus: number;
}

/**
 * Declare a domain error whose instances are already HTTP answers.
 *
 * @param name - Class name; also `error.name`.
 * @param options - Status table and per-code code/message/prefix overrides.
 * @returns A constructor called as `new XError(message, code, details?)`.
 *
 * @example
 * ```ts
 * // All three codes are conventional: nothing to configure.
 * export const AdminError = defineError("AdminError");
 * throw new AdminError("user not found", "NOT_FOUND"); // 404 ADMIN_NOT_FOUND
 * ```
 *
 * @example
 * ```ts
 * export const BillingError = defineError("BillingError", {
 *   codes: { INVALID_STATE: 409, VENUE_CONFLICT: 409 }, // only the unusual ones
 *   fallbackStatus: 422,
 * });
 * ```
 */
export function defineError<const C extends string = string>(
  name: string,
  options: DefineErrorOptions = {},
): DomainErrorClass<C> {
  const fallbackStatus = options.fallbackStatus ?? 400;
  const prefix = options.prefix ?? "";
  const statuses: Record<string, number> = {
    ...DOMAIN_CODE_STATUS,
    ...options.codes,
  };

  const statusFor = (code: string): number => statuses[code] ?? fallbackStatus;

  const ErrorClass = class extends HTTPError {
    /** The raw domain code, before HTTP prefixing. */
    readonly domainCode: C;

    constructor(message: string, code?: C, details?: Record<string, unknown>) {
      const resolved = (code ?? options.defaultCode) as C | undefined;
      if (resolved === undefined) {
        throw new TypeError(`${name}: a domain code is required`);
      }
      const clientCode =
        options.code ??
        options.codeNames?.[resolved] ??
        (prefix.length > 0 ? `${prefix}_${resolved}` : resolved);
      super(statusFor(resolved), options.messages?.[resolved] ?? message, clientCode, details, {
        origin: options.origin ?? "request",
      });
      this.name = name;
      this.domainCode = resolved;
    }
  };

  // Name the class itself (not just instances) so stacks, `constructor.name`
  // and test output read `BillingError` instead of `ErrorClass`.
  Object.defineProperty(ErrorClass, "name", { value: name, configurable: true });

  return Object.assign(ErrorClass, {
    errorName: name,
    statuses: Object.freeze(statuses),
    fallbackStatus,
  }) as unknown as DomainErrorClass<C>;
}
