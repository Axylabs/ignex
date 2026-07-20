// ============================================================================
// FLUX HTTP — Type-Safe Placeholder (Zero Runtime)
// ============================================================================

import type { FluxContext } from "./context";
import type { TSchema } from "./types";

type Handler<B = unknown, Q = URLSearchParams, P = Record<string, string>> = (
  ctx: FluxContext<P, Q, B>
) => Promise<unknown> | unknown;

/** Path is inferred from filename. Pass it only for DX. */
export function get<Q = URLSearchParams, P = Record<string, string>>(
  fn: Handler<unknown, Q, P>,
  _path?: string,
  _schema?: TSchema
): Handler<unknown, Q, P> {
  return fn;
}

/** Path is inferred from filename. Pass it only for DX. */
export function post<B = unknown, P = Record<string, string>>(
  fn: Handler<B, unknown, P>,
  _path?: string,
  _schema?: TSchema
): Handler<B, unknown, P> {
  return fn;
}

/** Path is inferred from filename. Pass it only for DX. */
export function put<B = unknown, P = Record<string, string>>(
  fn: Handler<B, unknown, P>,
  _path?: string,
  _schema?: TSchema
): Handler<B, unknown, P> {
  return fn;
}

/** Path is inferred from filename. Pass it only for DX. */
export function patch<B = unknown, P = Record<string, string>>(
  fn: Handler<B, unknown, P>,
  _path?: string,
  _schema?: TSchema
): Handler<B, unknown, P> {
  return fn;
}

/** Path is inferred from filename. Pass it only for DX. */
export function del<P = Record<string, string>>(
  fn: Handler<unknown, unknown, P>,
  _path?: string,
  _schema?: TSchema
): Handler<unknown, unknown, P> {
  return fn;
}

/** Path is inferred from filename. Pass it only for DX. */
export function all<B = unknown, Q = URLSearchParams, P = Record<string, string>>(
  fn: Handler<B, Q, P>,
  _path?: string,
  _schema?: TSchema
): Handler<B, Q, P> {
  return fn;
}