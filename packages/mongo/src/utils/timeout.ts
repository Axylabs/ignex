/**
 * Race a promise against a timeout. A `timeoutMs` <= 0 disables the timer and
 * returns the original promise untouched (zero-overhead fast path).
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/**
 * Sleep helper used by retry backoff.
 *
 * `unref` (default false) detaches the timer from the event loop, so a
 * background retry loop never keeps the process alive on its own (the
 * consumer's server/sockets do that). Watcher backoff passes `unref: true`;
 * awaited query retries keep the default so a pending call is never dropped.
 */
export const sleep = (ms: number, unref = false): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref?.();
  });

/**
 * Sleep for `ms` plus random jitter (0..jitterMs, capped at `ms`) so retry
 * loops don't resynchronize into a thundering herd after a replica failover.
 * Accepts the same `unref` option as {@link sleep}.
 */
export const sleepJittered = (ms: number, jitterMs = 1000, unref = false): Promise<void> =>
  sleep(ms + Math.floor(Math.random() * Math.min(ms, jitterMs)), unref);
