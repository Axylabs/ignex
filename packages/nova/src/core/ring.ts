/**
 * `RingBuffer<T>` — a fixed/auto-growing FIFO ring buffer with O(1) `push`
 * and `shift` (no array `shift()` memmove). Used by the drop-oldest
 * backpressure queue (`outbound.ts`) and the bounded replay history
 * (`replay.ts`), both of which previously used `Array.prototype.push` +
 * `shift` and were O(n) per operation while saturated.
 *
 * Two modes:
 *   - `bounded: true`  — capacity is fixed at construction; once full, `push`
 *     OVERWRITES the oldest element (drop-oldest). Ideal for "keep the last N".
 *   - `bounded: false` (default) — capacity doubles on demand (FIFO queue).
 *
 * Iteration walks oldest → newest without consuming.
 */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // index of the oldest element
  private len = 0;
  private readonly bounded: boolean;

  constructor(capacity = 16, bounded = false) {
    this.buf = Array.from({ length: Math.max(1, capacity) }, () => undefined as T | undefined);
    this.bounded = bounded;
  }

  /** Number of elements currently held. */
  get length(): number {
    return this.len;
  }

  /** Current backing capacity (grows on demand when unbounded). */
  get capacity(): number {
    return this.buf.length;
  }

  /**
   * Append `v`. When `bounded` and full, the OLDEST element is overwritten
   * (drop-oldest); otherwise the backing array grows.
   */
  push(v: T): void {
    if (this.len === this.buf.length) {
      if (this.bounded) {
        // overwrite the oldest slot, then treat it as the new tail
        this.buf[this.head] = v;
        this.head = (this.head + 1) % this.buf.length;
        return;
      }
      this.grow();
    }
    this.buf[(this.head + this.len) % this.buf.length] = v;
    this.len++;
  }

  /** Remove + return the oldest element, or `undefined` when empty. */
  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.buf.length;
    this.len--;
    return v;
  }

  /** Iterate oldest → newest (non-consuming). */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.len; i++) {
      yield this.buf[(this.head + i) % this.buf.length] as T;
    }
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.len = 0;
  }

  private grow(): void {
    const next = Array.from({ length: this.buf.length * 2 }, () => undefined as T | undefined);
    for (let i = 0; i < this.len; i++) {
      next[i] = this.buf[(this.head + i) % this.buf.length];
    }
    this.buf = next;
    this.head = 0;
  }
}
