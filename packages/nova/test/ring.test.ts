/**
 * RingBuffer unit tests — the O(1) FIFO used by the drop-oldest backpressure
 * queue (outbound.ts) and the bounded replay history (replay.ts). Pins the
 * ordering, wrap-around, bounded drop-oldest, and non-consuming iteration.
 */
import { describe, expect, test } from "bun:test";
import { RingBuffer } from "../src/core/ring";

describe("RingBuffer (unbounded FIFO)", () => {
  test("push/shift preserves FIFO order", () => {
    const q = new RingBuffer<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.length).toBe(3);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.length).toBe(0);
    expect(q.shift()).toBeUndefined(); // empty shift is safe
  });

  test("grows past the initial capacity without losing order", () => {
    const q = new RingBuffer<number>(2); // tiny initial capacity
    const n = 100;
    for (let i = 0; i < n; i++) q.push(i);
    expect(q.length).toBe(n);
    for (let i = 0; i < n; i++) expect(q.shift()).toBe(i);
  });

  test("head wraps past the backing-array end (interleaved push/shift)", () => {
    const q = new RingBuffer<number>(4);
    for (let i = 0; i < 4; i++) q.push(i); // fill: head at 0
    expect(q.shift()).toBe(0); // head → 1
    expect(q.shift()).toBe(1); // head → 2
    q.push(10); // tail wraps to index 0
    q.push(11); // tail wraps to index 1
    expect([...q]).toEqual([2, 3, 10, 11]);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBe(10);
    expect(q.shift()).toBe(11);
  });
});

describe("RingBuffer (bounded drop-oldest)", () => {
  test("once full, push overwrites the oldest (keeps the last N)", () => {
    const q = new RingBuffer<string>(3, true);
    for (const s of ["W", "X", "Y", "Z"]) q.push(s);
    expect(q.length).toBe(3); // never exceeds capacity
    expect([...q]).toEqual(["X", "Y", "Z"]);
  });

  test("iteration walks oldest → newest without consuming", () => {
    const q = new RingBuffer<number>(3, true);
    for (let i = 1; i <= 5; i++) q.push(i); // keeps 3, 4, 5
    expect([...q]).toEqual([3, 4, 5]);
    expect([...q]).toEqual([3, 4, 5]); // iterating again sees the same items
    expect(q.length).toBe(3); // nothing consumed
  });

  test("clear() empties the buffer", () => {
    const q = new RingBuffer<number>(2, true);
    q.push(1);
    q.push(2);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.shift()).toBeUndefined();
  });
});
