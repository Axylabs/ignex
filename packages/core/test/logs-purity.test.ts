/**
 * @fileoverview Purity tests for the process-wide log store (`logs.ts`).
 *
 * `installLogStore` silently overwrote the module-level store — a SECOND
 * plugin/debugbar boot path could clobber the first one's capture with zero
 * signal. The guard warns when a DIFFERENT store replaces the active one
 * (still installing, so behavior is unchanged) and stays silent on idempotent
 * re-installs and symmetric uninstall/install cycles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeLogStore,
  debugLog,
  installLogStore,
  LogStore,
  uninstallLogStore,
} from "../src/debug/logs";

const makeStore = () => new LogStore({ maxRecords: 16 });
const warnSpy = () => vi.mocked(console.warn);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  uninstallLogStore();
  warnSpy().mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallLogStore();
});

describe("installLogStore — swap guard", () => {
  it("still installs the latest store when a different one replaces the active store, and warns", () => {
    const a = makeStore();
    const b = makeStore();
    expect(installLogStore(a)).toBe(a);
    expect(warnSpy()).not.toHaveBeenCalled();

    expect(installLogStore(b)).toBe(b); // different store replaces a — visible
    expect(warnSpy()).toHaveBeenCalledTimes(1);
    expect(activeLogStore()).toBe(b);
  });

  it("is silent on idempotent re-installs of the same store", () => {
    const a = makeStore();
    installLogStore(a);
    installLogStore(a);
    installLogStore(a);
    expect(warnSpy()).not.toHaveBeenCalled();
  });

  it("is silent after a symmetric uninstall/install cycle", () => {
    const a = makeStore();
    installLogStore(a);
    uninstallLogStore();
    installLogStore(a);
    expect(warnSpy()).not.toHaveBeenCalled();
    expect(activeLogStore()).toBe(a);
  });

  it("routes debugLog to the active store", () => {
    const store = makeStore();
    installLogStore(store);
    debugLog("info", "hello", { kind: "test" });
    expect(store.stats().total).toBe(1);
    const record = store.list()[0];
    expect(record?.message).toBe("hello");
    expect(record?.attrs).toEqual({ kind: "test" });

    uninstallLogStore();
    debugLog("info", "dropped"); // no store — safe no-op
    expect(store.stats().total).toBe(1);
  });
});
