/**
 * @fileoverview Functional Programming Primitives v3.0
 * Zero-dependency utility belt. All functions are pure, curried, and total.
 * Enhanced with Result monad, Task, and pipe composition.
 */

import memoizee from "memoizee";
import pRetry from "p-retry";
import pTimeout, { TimeoutError } from "p-timeout";
import justDebounce from "just-debounce";
import justThrottle from "just-throttle";
import { dequal } from "dequal";



export const pipe =
  <A>(a: A) =>
  <B>(...fns: Array<(x: any) => any>): B =>
    fns.reduce((acc: any, fn) => fn(acc), a) as unknown as B;

export const compose =
  <A>(...fns: Array<(x: any) => any>) =>
  (a: A) =>
    fns.reduceRight((acc: any, fn) => fn(acc), a);

export const flow =
  <A extends any[], B>(...fns: Array<(...args: any[]) => any>) =>
  (...args: A): B =>
    fns.reduce(
      (acc, fn, i) => (i === 0 ? fn(...args) : fn(acc)),
      undefined as any
    ) as B;
// ============================================================================
// Array Operations (Pure)
// ============================================================================

export const map = <T, U>(fn: (x: T, i: number) => U) => (arr: readonly T[]): U[] =>
  arr.map(fn);

export const filter = <T>(fn: (x: T, i: number) => boolean) => (arr: readonly T[]): T[] =>
  arr.filter(fn);

export const reduce = <T, U>(fn: (acc: U, x: T, i: number) => U, init: U) => (arr: readonly T[]): U =>
  arr.reduce(fn, init);

export const flatMap = <T, U>(fn: (x: T) => readonly U[]) => (arr: readonly T[]): U[] =>
  arr.flatMap(fn);

export const find = <T>(fn: (x: T) => boolean) => (arr: readonly T[]): T | undefined =>
  arr.find(fn);

export const some = <T>(fn: (x: T) => boolean) => (arr: readonly T[]): boolean =>
  arr.some(fn);

export const every = <T>(fn: (x: T) => boolean) => (arr: readonly T[]): boolean =>
  arr.every(fn);

export const groupBy = <T, K extends string | number>(keyFn: (x: T) => K) => (arr: readonly T[]): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) existing.push(item);
    else map.set(key, [item]);
  }
  return map;
};

export const toMap = <T, K>(keyFn: (x: T) => K) => (arr: readonly T[]): Map<K, T> => {
  const map = new Map<K, T>();
  for (const item of arr) map.set(keyFn(item), item);
  return map;
};

export const sortBy = <T>(compare: (a: T, b: T) => number) => (arr: readonly T[]): T[] =>
  [...arr].sort(compare);

export const partition = <T>(fn: (x: T) => boolean) => (arr: readonly T[]): [T[], T[]] => {
  const pass: T[] = [];
  const fail: T[] = [];
  for (const item of arr) (fn(item) ? pass : fail).push(item);
  return [pass, fail];
};

export const unique = <T>(arr: readonly T[]): T[] => [...new Set(arr)];

export const chunk = <T>(size: number) => (arr: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size) as T[]);
  return result;
};

export const zip = <A, B>(a: readonly A[], b: readonly B[]): [A, B][] =>
  a.map((x, i) => [x, b[i]!] as [A, B]);

// ============================================================================
// Object Operations (Pure)
// ============================================================================

export const pick = <T extends object, K extends keyof T>(...keys: K[]) => (obj: T): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  for (const key of keys) if (key in obj) result[key] = obj[key];
  return result;
};

export const omit = <T extends object, K extends keyof T>(...keys: K[]) => (obj: T): Omit<T, K> => {
  const result = { ...obj };
  for (const key of keys) delete result[key];
  return result as Omit<T, K>;
};

export const merge = <T extends object>(...sources: Partial<T>[]) => (target: T): T =>
  Object.assign({}, target, ...sources);

export const mergeDeep = <T extends Record<string, any>>(target: T, source: Partial<T>): T => {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key as keyof T];
    const tv = target[key as keyof T];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      (output as any)[key] = mergeDeep(tv as any, sv as any);
    } else if (sv !== undefined) {
      (output as any)[key] = sv;
    }
  }
  return output;
};

export const entries = <T extends object>(obj: T): [keyof T, T[keyof T]][] =>
  Object.entries(obj) as any;

export const fromEntries = <K extends string, V>(entries: [K, V][]): Record<K, V> =>
  Object.fromEntries(entries) as Record<K, V>;

// ============================================================================
// Side-Effect Management
// ============================================================================

export const tap = <T>(fn: (x: T) => void) => (x: T): T => { fn(x); return x; };
export const id = <T>(x: T): T => x;
export const constant = <T>(x: T) => (): T => x;
export const noop = (): void => {};

// ============================================================================
// Result Monad (Error handling without exceptions)
// ============================================================================

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const unwrapOr = <T>(fallback: T) => (r: Result<T>): T =>
  r.ok ? r.value : fallback;

export const unwrapOrElse = <T, E>(fn: (e: E) => T) => (r: Result<T, E>): T =>
  r.ok ? r.value : fn(r.error);

export const mapResult = <T, U>(fn: (x: T) => U) => <E>(r: Result<T, E>): Result<U, E> =>
  r.ok ? ok(fn(r.value)) : r;

export const flatMapResult = <T, U, E>(fn: (x: T) => Result<U, E>) => (r: Result<T, E>): Result<U, E> =>
  r.ok ? fn(r.value) : r;

export const mapErr = <E, F>(fn: (e: E) => F) => <T>(r: Result<T, E>): Result<T, F> =>
  r.ok ? r : err(fn(r.error));

export const tryCatch = <T>(fn: () => T): Result<T, unknown> => {
  try { return ok(fn()); }
  catch (error) { return err(error); }
};

export const tryCatchAsync = async <T>(fn: () => Promise<T>): Promise<Result<T, unknown>> => {
  try { return ok(await fn()); }
  catch (error) { return err(error); }
};

export const tryCatchOr = <T>(fallback: T, fn: () => T): T => {
  try { return fn(); }
  catch { return fallback; }
};

// ============================================================================
// Task (Lazy async computation)
// ============================================================================

export type Task<T> = () => Promise<T>;

export const taskMap = <T, U>(fn: (x: T) => U) => (task: Task<T>): Task<U> =>
  async () => fn(await task());

export const taskChain = <T, U>(fn: (x: T) => Task<U>) => (task: Task<T>): Task<U> =>
  async () => fn(await task())();

export const taskFromResult = <T>(value: T): Task<T> => async () => value;

// ============================================================================
// Predicate & Comparison
// ============================================================================

export const not = <T>(fn: (x: T) => boolean) => (x: T): boolean => !fn(x);
export const and = <T>(...fns: ((x: T) => boolean)[]) => (x: T): boolean => fns.every(fn => fn(x));
export const or = <T>(...fns: ((x: T) => boolean)[]) => (x: T): boolean => fns.some(fn => fn(x));

export const equals = <T>(a: T) => (b: T): boolean => a === b;
export const deepEquals = (a: unknown, b: unknown): boolean => dequal(a, b);

// ============================================================================
// String Utilities
// ============================================================================

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const camelCase = (s: string): string => s.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : "");
export const kebabCase = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
export const snakeCase = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

// ============================================================================
// Number Utilities
// ============================================================================

export const clamp = (min: number, max: number) => (n: number): number =>
  Math.min(Math.max(n, min), max);

export const range = (start: number, end: number, step = 1): number[] => {
  const result: number[] = [];
  for (let i = start; i < end; i += step) result.push(i);
  return result;
};

// ============================================================================
// Async Utilities
// ============================================================================

export const delay = (ms: number): Task<void> =>
  () => new Promise((r) => setTimeout(r, ms));

export const retry =
  <T>(attempts: number, delayMs = 0) =>
  (fn: () => Promise<T>): Promise<T> =>
    pRetry(fn, {
      retries: Math.max(0, attempts - 1),
      factor: 1,
      minTimeout: delayMs,
      maxTimeout: delayMs,
      randomize: false,
    });

export const memoize = <A extends any[], R>(
  fn: (...args: A) => R
): ((...args: A) => R) =>
  memoizee(fn, {
    normalizer: (args: A) => JSON.stringify(args),
    maxAge: 10 * 60 * 1000,
  }) as (...args: A) => R;


export const debounce = <A extends any[]>(
  ms: number,
  fn: (...args: A) => void
) => justDebounce(fn, ms);


export const throttle = <A extends any[]>(
  ms: number,
  fn: (...args: A) => void
) => justThrottle(fn, ms);