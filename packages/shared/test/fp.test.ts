/**
 * FP toolkit tests — Result, Task, pipe/compose, always/identity.
 */

import {
  always,
  compose,
  err,
  flatMapResult,
  identity,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  pipe,
  taskChain,
  taskFromResult,
  taskMap,
  tryCatch,
  tryCatchAsync,
  tryCatchOr,
  unwrapOr,
  unwrapOrElse,
} from "@flux/shared";
import { describe, expect, it } from "vitest";

describe("Result", () => {
  it("constructs ok/err and narrows with isOk/isErr", () => {
    const a = ok(42);
    expect(isOk(a)).toBe(true);
    if (isOk(a)) expect(a.value).toBe(42);

    const b = err("boom");
    expect(isErr(b)).toBe(true);
    if (isErr(b)) expect(b.error).toBe("boom");
  });

  it("unwrapOr / unwrapOrElse", () => {
    expect(unwrapOr(0)(ok(5))).toBe(5);
    expect(unwrapOr(0)(err("e"))).toBe(0);
    expect(unwrapOrElse((e) => e.length)(ok(7))).toBe(7);
    expect(unwrapOrElse((e) => e.length)(err("abc"))).toBe(3);
  });

  it("mapResult / flatMapResult / mapErr", () => {
    expect(mapResult((x) => x * 2)(ok(3))).toEqual({ ok: true, value: 6 });
    expect(mapResult((x) => x * 2)(err("e"))).toEqual({ ok: false, error: "e" });

    expect(flatMapResult((x) => (x > 0 ? ok(x) : err("neg")))(ok(-1))).toEqual({
      ok: false,
      error: "neg",
    });
    expect(flatMapResult((x) => ok(x + 1))(ok(1))).toEqual({ ok: true, value: 2 });

    expect(mapErr((e) => `E:${e}`)(err("x"))).toEqual({ ok: false, error: "E:x" });
    expect(mapErr((e) => `E:${e}`)(ok(1))).toEqual({ ok: true, value: 1 });
  });

  it("tryCatch / tryCatchAsync / tryCatchOr", async () => {
    expect(tryCatch(() => 1)).toEqual({ ok: true, value: 1 });
    expect(
      tryCatch(() => {
        throw new Error("x");
      }).ok,
    ).toBe(false);

    expect(await tryCatchAsync(async () => 2)).toEqual({ ok: true, value: 2 });
    expect(
      await tryCatchAsync(async () => {
        throw new Error("y");
      }).then((r) => r.ok),
    ).toBe(false);

    expect(
      tryCatchOr("fb", () => {
        throw new Error();
      }),
    ).toBe("fb");
    expect(tryCatchOr("fb", () => "v")).toBe("v");
  });
});

describe("Task", () => {
  it("taskFromResult / taskMap / taskChain", async () => {
    expect(await taskFromResult(5)()).toBe(5);
    expect(await taskMap((x) => x + 1)(taskFromResult(5))()).toBe(6);
    expect(await taskChain((x) => taskFromResult(x * 2))(taskFromResult(3))()).toBe(6);
  });
});

describe("Composition", () => {
  const add = (n: number) => (x: number) => x + n;

  it("pipe composes left-to-right", () => {
    expect(pipe(1)(add(1), add(2))).toBe(4);
  });

  it("compose composes right-to-left", () => {
    // compose(f, g)(x) === f(g(x))
    expect(compose(add(2), add(3))(1)).toBe(6);
  });

  it("always / identity", () => {
    expect(always(9)()).toBe(9);
    expect(identity("x")).toBe("x");
  });
});
