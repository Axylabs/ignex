/**
 * @fileoverview Purity tests for the request tracer (`tracer.ts`).
 *
 * Two ambient-state concerns are pinned here:
 *  1. Span-id generation was a module-level counter (`nextSpanId`) shared by
 *     every `Trace` — impossible to scope or reset, and it made span ids a
 *     hidden cross-trace dependency. The fix injects a per-trace
 *     {@link SpanIdSource} (defaulting to the process-wide counter so the
 *     debugbar UI keeps its global ordering).
 *  2. `setTracingEnabled` reconfiguration (a change AFTER first config) is
 *     suspicious — it means a second plugin/boot path toggled ambient process
 *     state. That must be visible, not silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTrace,
  createSpanIdSource,
  isTracingEnabled,
  setTracingEnabled,
  Trace,
} from "../src/debug/tracer";
import { createContext } from "../src/http/context";

const makeCtx = () => createContext(new Request("http://localhost/tracer-purity"), {});

describe("createSpanIdSource", () => {
  it("yields a strictly increasing sequence from 1 by default", () => {
    const source = createSpanIdSource();
    expect(source()).toBe(1);
    expect(source()).toBe(2);
    expect(source()).toBe(3);
  });

  it("honours a custom start", () => {
    const source = createSpanIdSource(1000);
    expect(source()).toBe(1000);
    expect(source()).toBe(1001);
  });

  it("produces independent, non-colliding sequences across sources", () => {
    const a = createSpanIdSource();
    const b = createSpanIdSource();
    // Interleaved reads: neither source sees the other's progress.
    expect(a()).toBe(1);
    expect(b()).toBe(1);
    expect(a()).toBe(2);
    expect(b()).toBe(2);
  });
});

describe("Trace span ids", () => {
  it("uses the injected span-id source when one is provided", () => {
    const source = createSpanIdSource(1000);
    const trace = new Trace(makeCtx(), false, source);
    const first = trace.start("a");
    const second = trace.start("b");
    expect(first.id).toBe(1000);
    expect(second.id).toBe(1001);
  });

  it("keeps the process-wide default source when none is injected (global ordering)", () => {
    const a = beginTrace(makeCtx(), false);
    const b = beginTrace(makeCtx(), false);
    const aSpan = a.start("x");
    const bSpan = b.start("y");
    // Two independent traces share the ambient counter — ids stay global and
    // strictly increasing for the debugbar UI (no collision across traces).
    expect(bSpan.id).toBe(aSpan.id + 1);
  });
});

describe("setTracingEnabled reconfiguration guard", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setTracingEnabled(true); // first configuration — silent, observed by the spy
    vi.mocked(console.warn).mockClear(); // normalise whatever a prior test left behind
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setTracingEnabled(false);
  });

  it("warns when reconfiguring to a different value after first configuration", () => {
    setTracingEnabled(false); // change after configured — visible
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(isTracingEnabled()).toBe(false);
    // And still applies subsequent changes.
    setTracingEnabled(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(isTracingEnabled()).toBe(true);
  });

  it("is silent on idempotent re-sets", () => {
    setTracingEnabled(true);
    setTracingEnabled(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
