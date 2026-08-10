/**
 * Shared functional core — `Result`, `Task`, `pipe`, `compose`.
 *
 * A deliberately small, dependency-free FP toolkit used by `@flux/core`,
 * `@flux/compiler` and `@flux/native`. If you need debounce/throttle/memoize/
 * retry, add them in a separate optional module — they do not belong in the
 * hot runtime paths.
 */

// ── Result ──────────────────────────────────────────────────────

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const unwrapOr =
  <T>(fallback: T) =>
  (r: Result<T>): T =>
    r.ok ? r.value : fallback;

export const unwrapOrElse =
  <T, E>(fn: (e: E) => T) =>
  (r: Result<T, E>): T =>
    r.ok ? r.value : fn(r.error);

export const mapResult =
  <T, U>(fn: (x: T) => U) =>
  <E>(r: Result<T, E>): Result<U, E> =>
    r.ok ? ok(fn(r.value)) : r;

export const flatMapResult =
  <T, U, E>(fn: (x: T) => Result<U, E>) =>
  (r: Result<T, E>): Result<U, E> =>
    r.ok ? fn(r.value) : r;

export const mapErr =
  <E, F>(fn: (e: E) => F) =>
  <T>(r: Result<T, E>): Result<T, F> =>
    r.ok ? r : err(fn(r.error));

export const tryCatch = <T>(fn: () => T): Result<T, unknown> => {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
};

export const tryCatchAsync = async <T>(fn: () => Promise<T>): Promise<Result<T, unknown>> => {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
};

export const tryCatchOr = <T>(fallback: T, fn: () => T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// ── Task ────────────────────────────────────────────────────────

export type Task<T> = () => Promise<T>;

export const taskMap =
  <T, U>(fn: (x: T) => U) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task());

export const taskChain =
  <T, U>(fn: (x: T) => Task<U>) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task())();

export const taskFromResult =
  <T>(value: T): Task<T> =>
  async () =>
    value;

// ── Composition ─────────────────────────────────────────────────

/**
 * Left-to-right function composition:
 * `pipe(value)(f, g, h)` === `h(g(f(value)))`.
 */
export const pipe =
  <A>(a: A) =>
  <B>(...fns: Array<(x: any) => any>): B =>
    fns.reduce((acc: any, fn) => fn(acc), a) as unknown as B;

/**
 * Right-to-left function composition:
 * `compose(f, g, h)(x)` === `f(g(h(x)))`.
 */
export const compose =
  <A>(...fns: Array<(x: any) => any>): ((x: A) => any) =>
  (x: A) =>
    fns.reduceRight((acc: any, fn) => fn(acc), x);

/** Constant function: `always(v)(...)` === `v`. */
export const always =
  <T>(value: T) =>
  (): T =>
    value;

/** Identity function. */
export const identity = <T>(value: T): T => value;
