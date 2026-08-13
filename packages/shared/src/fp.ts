/**
 * Shared functional core — `Result`, `Task`, `pipe`, `compose`.
 *
 * A deliberately small, dependency-free FP toolkit used by `@ignex/core` and
 * `@ignex/compiler`. If you need debounce/throttle/memoize/retry, add them in a
 * separate optional module — they do not belong in the hot runtime paths.
 */

// ── Result ──────────────────────────────────────────────────────

/**
 * A discriminated union representing a successful value (`{ ok: true }`) or a
 * failure (`{ ok: false, error }`). The error defaults to `string` but can be
 * any type via the `E` parameter.
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wrap a value in a successful result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Wrap an error in a failed result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Type guard narrowing a `Result` to its success variant. */
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

/** Type guard narrowing a `Result` to its failure variant. */
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/**
 * Extract the value of a result, or return `fallback` when it is an error.
 *
 * @param fallback - Returned unchanged for error results.
 */
export const unwrapOr =
  <T>(fallback: T) =>
  (r: Result<T>): T =>
    r.ok ? r.value : fallback;

/**
 * Extract the value of a result, or compute a fallback from the error.
 *
 * @param fn - Receives the error and produces the fallback value.
 */
export const unwrapOrElse =
  <T, E>(fn: (e: E) => T) =>
  (r: Result<T, E>): T =>
    r.ok ? r.value : fn(r.error);

/**
 * Map the value of a successful result; error results pass through unchanged.
 *
 * @param fn - Applied to the value of an `ok` result.
 */
export const mapResult =
  <T, U>(fn: (x: T) => U) =>
  <E>(r: Result<T, E>): Result<U, E> =>
    r.ok ? ok(fn(r.value)) : r;

/**
 * Chain a result-returning function over a successful value; errors short-circuit.
 *
 * @param fn - Must return a `Result` whose error type matches `E`.
 */
export const flatMapResult =
  <T, U, E>(fn: (x: T) => Result<U, E>) =>
  (r: Result<T, E>): Result<U, E> =>
    r.ok ? fn(r.value) : r;

/**
 * Map the error of a failed result; successful results pass through unchanged.
 *
 * @param fn - Applied to the error of an `err` result.
 */
export const mapErr =
  <E, F>(fn: (e: E) => F) =>
  <T>(r: Result<T, E>): Result<T, F> =>
    r.ok ? r : err(fn(r.error));

/**
 * Run a throwing function and capture its outcome as a `Result`.
 *
 * @returns `ok(fn())` on success, or `err(error)` with the thrown value.
 */
export const tryCatch = <T>(fn: () => T): Result<T, unknown> => {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
};

/** Async variant of {@link tryCatch}: awaits `fn` and captures rejections. */
export const tryCatchAsync = async <T>(fn: () => Promise<T>): Promise<Result<T, unknown>> => {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
};

/**
 * Run a throwing function, returning `fallback` when it throws.
 *
 * @param fallback - Returned unchanged if `fn` throws.
 * @param fn - Invoked and its return value returned on success.
 */
export const tryCatchOr = <T>(fallback: T, fn: () => T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// ── Task ────────────────────────────────────────────────────────

/** A deferred, repeatable computation: a zero-argument async function. */
export type Task<T> = () => Promise<T>;

/**
 * Map a task's resolved value.
 *
 * @param fn - Applied to the awaited result of `task`.
 */
export const taskMap =
  <T, U>(fn: (x: T) => U) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task());

/**
 * Chain a task-returning function after a task.
 *
 * @param fn - Receives the resolved value and returns the next `Task`.
 */
export const taskChain =
  <T, U>(fn: (x: T) => Task<U>) =>
  (task: Task<T>): Task<U> =>
  async () =>
    fn(await task())();

/** Lift a plain value into an immediately-resolving `Task`. */
export const taskFromResult =
  <T>(value: T): Task<T> =>
  async () =>
    value;

// ── Composition ─────────────────────────────────────────────────

/** `T` or anything promise-like — used to type async-capable pipe stages. */
type Awaitable<T> = T | PromiseLike<T>;

/**
 * Left-to-right function composition:
 * `pipe(value)(f, g, h)` === `h(g(f(value)))`.
 *
 * The chain is fully type-checked: each stage's return type is threaded into
 * the next stage's parameter, and the result is the final stage's return type.
 *
 * @param a - Initial value fed into the first stage.
 */
export function pipe<A>(a: A): {
  (): A;
  <B>(...fns: [(a: A) => B]): B;
  <B, C>(...fns: [(a: A) => B, (b: B) => C]): C;
  <B, C, D>(...fns: [(a: A) => B, (b: B) => C, (c: C) => D]): D;
  <B, C, D, E>(...fns: [(a: A) => B, (b: B) => C, (c: C) => D, (d: D) => E]): E;
  <B, C, D, E, F>(...fns: [(a: A) => B, (b: B) => C, (c: C) => D, (d: D) => E, (e: E) => F]): F;
  <B, C, D, E, F, G>(
    ...fns: [(a: A) => B, (b: B) => C, (c: C) => D, (d: D) => E, (e: E) => F, (f: F) => G]
  ): G;
  <B, C, D, E, F, G, H>(
    ...fns: [
      (a: A) => B,
      (b: B) => C,
      (c: C) => D,
      (d: D) => E,
      (e: E) => F,
      (f: F) => G,
      (g: G) => H,
    ]
  ): H;
  <B, C, D, E, F, G, H, I>(
    ...fns: [
      (a: A) => B,
      (b: B) => C,
      (c: C) => D,
      (d: D) => E,
      (e: E) => F,
      (f: F) => G,
      (g: G) => H,
      (h: H) => I,
    ]
  ): I;
  <B, C, D, E, F, G, H, I, J>(
    ...fns: [
      (a: A) => B,
      (b: B) => C,
      (c: C) => D,
      (d: D) => E,
      (e: E) => F,
      (f: F) => G,
      (g: G) => H,
      (h: H) => I,
      (i: I) => J,
    ]
  ): J;
};
export function pipe<A>(a: A) {
  return (...fns: Array<(x: any) => any>): unknown =>
    fns.reduce((acc: unknown, fn) => fn(acc), a as unknown);
}

/**
 * Right-to-left function composition:
 * `compose(f, g, h)(x)` === `f(g(h(x)))`.
 *
 * The last function receives the argument; each earlier function receives the
 * previous one's return value. Fully type-checked like {@link pipe}.
 */
export function compose<A, B>(f: (b: A) => B): (a: A) => B;
export function compose<A, B, C>(f: (b: B) => C, g: (a: A) => B): (a: A) => C;
export function compose<A, B, C, D>(f: (c: C) => D, g: (b: B) => C, h: (a: A) => B): (a: A) => D;
export function compose<A, B, C, D, E>(
  f: (d: D) => E,
  g: (c: C) => D,
  h: (b: B) => C,
  i: (a: A) => B,
): (a: A) => E;
export function compose<A, B, C, D, E, F>(
  f: (e: E) => F,
  g: (d: D) => E,
  h: (c: C) => D,
  i: (b: B) => C,
  j: (a: A) => B,
): (a: A) => F;
export function compose<A, B, C, D, E, F, G>(
  f: (f0: F) => G,
  g: (e: E) => F,
  h: (d: D) => E,
  i: (c: C) => D,
  j: (b: B) => C,
  k: (a: A) => B,
): (a: A) => G;
export function compose<A, B, C, D, E, F, G, H>(
  f: (g0: G) => H,
  g: (f0: F) => G,
  h: (e: E) => F,
  i: (d: D) => E,
  j: (c: C) => D,
  k: (b: B) => C,
  l: (a: A) => B,
): (a: A) => H;
export function compose(...fns: Array<(x: any) => any>): (x: any) => any {
  return (x) => fns.reduceRight((acc: unknown, fn) => fn(acc), x);
}

/**
 * Async left-to-right function composition:
 * `pipeAsync(value)(f, g, h)` === `h(g(f(value)))` with every stage awaited.
 *
 * Each stage may return a plain value or a `Promise`; the resolved value is
 * threaded into the next stage, so sync and async stages can be freely mixed.
 * The result is a `Promise` of the final stage's resolved type.
 *
 * @param a - Initial value fed into the first stage.
 */
export function pipeAsync<A>(a: A): {
  (): Promise<A>;
  <B>(...fns: [(a: A) => Awaitable<B>]): Promise<B>;
  <B, C>(...fns: [(a: A) => Awaitable<B>, (b: B) => Awaitable<C>]): Promise<C>;
  <B, C, D>(
    ...fns: [(a: A) => Awaitable<B>, (b: B) => Awaitable<C>, (c: C) => Awaitable<D>]
  ): Promise<D>;
  <B, C, D, E>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
    ]
  ): Promise<E>;
  <B, C, D, E, F>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
      (e: E) => Awaitable<F>,
    ]
  ): Promise<F>;
  <B, C, D, E, F, G>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
      (e: E) => Awaitable<F>,
      (f: F) => Awaitable<G>,
    ]
  ): Promise<G>;
  <B, C, D, E, F, G, H>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
      (e: E) => Awaitable<F>,
      (f: F) => Awaitable<G>,
      (g: G) => Awaitable<H>,
    ]
  ): Promise<H>;
  <B, C, D, E, F, G, H, I>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
      (e: E) => Awaitable<F>,
      (f: F) => Awaitable<G>,
      (g: G) => Awaitable<H>,
      (h: H) => Awaitable<I>,
    ]
  ): Promise<I>;
  <B, C, D, E, F, G, H, I, J>(
    ...fns: [
      (a: A) => Awaitable<B>,
      (b: B) => Awaitable<C>,
      (c: C) => Awaitable<D>,
      (d: D) => Awaitable<E>,
      (e: E) => Awaitable<F>,
      (f: F) => Awaitable<G>,
      (g: G) => Awaitable<H>,
      (h: H) => Awaitable<I>,
      (i: I) => Awaitable<J>,
    ]
  ): Promise<J>;
};
export function pipeAsync<A>(a: A) {
  return async (...fns: Array<(x: any) => any>): Promise<unknown> => {
    let acc: unknown = a;
    for (const fn of fns) acc = await fn(acc);
    return acc;
  };
}

/**
 * Left fold over an array:
 * `fold(init, fn)([a, b, c])` === `fn(fn(fn(init, a), b), c)`.
 * The curried shape matches `pipe`/`compose` and is used to fold hook / config
 * / plugin stage chains into a single composed runner.
 */
export const fold =
  <A, B>(init: B, fn: (acc: B, item: A, index: number) => B) =>
  (items: readonly A[]): B =>
    items.reduce((acc, item, i) => fn(acc, item, i), init);

/** Constant function: `always(v)(...)` === `v`. */
export const always =
  <T>(value: T) =>
  (): T =>
    value;

/** Identity function. */
export const identity = <T>(value: T): T => value;
