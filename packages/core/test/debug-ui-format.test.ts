/**
 * @fileoverview Formatting helpers shared by every debugbar view.
 *
 * These decide what an operator reads in the debug panels — a duration cell, a
 * relative timestamp, the severity colour of a status code — so the boundaries
 * (100 ms "ok", 500 ms "slow", 400 vs 500 status families) are pinned here
 * rather than discovered by squinting at the dashboard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durClass,
  envTone,
  fmtMs,
  fmtNum,
  fmtUptime,
  headerValue,
  kindColor,
  looksLikeJson,
  methodCls,
  prettyJson,
  sqlPillCls,
  statusCls,
  timeAgo,
  timeHM,
} from "../src/debug/ui/format";

afterEach(() => {
  vi.useRealTimers();
});

describe("fmtMs / fmtNum", () => {
  it("renders a dash for a missing duration", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(undefined)).toBe("—");
  });

  it("renders two decimals and the unit", () => {
    expect(fmtMs(1.239)).toBe("1.24 ms");
    expect(fmtMs(0)).toBe("0.00 ms");
  });

  it("renders counts verbatim and a dash when absent", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(1234)).toBe("1234");
    expect(fmtNum(null)).toBe("—");
  });
});

describe("durClass", () => {
  it("is ok below 100ms", () => {
    expect(durClass(0)).toBe("text-ok");
    expect(durClass(99.9)).toBe("text-ok");
  });

  it("warns between 100ms and 500ms", () => {
    expect(durClass(100)).toBe("text-warn");
    expect(durClass(499.9)).toBe("text-warn");
  });

  it("is err from 500ms up", () => {
    expect(durClass(500)).toBe("text-err");
    expect(durClass(60_000)).toBe("text-err");
  });
});

describe("timeAgo", () => {
  const now = 1_700_000_000_000;
  const ago = (seconds: number): string => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    return timeAgo(now - seconds * 1000);
  };

  it("says 'just now' under five seconds", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(4)).toBe("just now");
  });

  it("renders seconds, minutes and hours", () => {
    expect(ago(5)).toBe("5s ago");
    expect(ago(59)).toBe("59s ago");
    expect(ago(60)).toBe("1m ago");
    expect(ago(59 * 60)).toBe("59m ago");
    expect(ago(3600)).toBe("1h ago");
    expect(ago(23 * 3600)).toBe("23h ago");
  });

  it("falls back to a calendar date past a day", () => {
    const out = ago(24 * 3600);
    expect(out).not.toMatch(/ago|just now/);
    expect(out).toBe(new Date(now - 24 * 3600 * 1000).toLocaleDateString());
  });
});

describe("timeHM", () => {
  it("renders a local hh:mm:ss clock", () => {
    // The day-period suffix is locale-dependent; the clock itself is not.
    expect(timeHM(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}(\s*[AP]M)?$/i);
  });
});

describe("methodCls", () => {
  it("lowercases the method for the colour class", () => {
    expect(methodCls("GET")).toBe("get");
    expect(methodCls("Delete")).toBe("delete");
  });

  it("returns an empty token when the method is unknown", () => {
    expect(methodCls(null)).toBe("");
    expect(methodCls(undefined)).toBe("");
  });
});

describe("statusCls", () => {
  it("maps status families", () => {
    expect(statusCls(500)).toBe("err");
    expect(statusCls(503)).toBe("err");
    expect(statusCls(404)).toBe("warn");
    expect(statusCls(400)).toBe("warn");
    expect(statusCls(301)).toBe("info");
    expect(statusCls(204)).toBe("ok");
    expect(statusCls(200)).toBe("ok");
  });
});

describe("kindColor", () => {
  it("maps every span kind to its palette variable", () => {
    expect(kindColor("db")).toBe("var(--cat-1)");
    expect(kindColor("cache")).toBe("var(--cat-2)");
    expect(kindColor("error")).toBe("var(--cat-8)");
    expect(kindColor("request")).toBe("var(--cat-6)");
  });

  it("falls back to the custom palette slot", () => {
    expect(kindColor("something-new")).toBe("var(--cat-7)");
  });
});

describe("sqlPillCls", () => {
  it("classifies the four DML verbs", () => {
    expect(sqlPillCls("select")).toBe("select");
    expect(sqlPillCls("INSERT")).toBe("insert");
    expect(sqlPillCls("Update")).toBe("update");
    expect(sqlPillCls("delete")).toBe("delete");
  });

  it("classifies anything else as other, including a missing action", () => {
    expect(sqlPillCls("ALTER")).toBe("other");
    expect(sqlPillCls(null)).toBe("other");
    expect(sqlPillCls(undefined)).toBe("other");
  });
});

describe("fmtUptime", () => {
  it("renders the largest useful unit", () => {
    expect(fmtUptime(0)).toBe("0s");
    expect(fmtUptime(45)).toBe("45s");
    expect(fmtUptime(60)).toBe("1m");
    expect(fmtUptime(3661)).toBe("1h 1m");
    expect(fmtUptime(90_061)).toBe("1d 1h");
  });

  it("clamps negatives and non-numbers to zero", () => {
    expect(fmtUptime(-5)).toBe("0s");
    expect(fmtUptime(Number.NaN)).toBe("0s");
  });
});

describe("envTone", () => {
  it("flags production", () => {
    expect(envTone("production")).toBe("err");
    expect(envTone("PROD")).toBe("err");
  });

  it("accepts dev/local", () => {
    expect(envTone("development")).toBe("ok");
    expect(envTone("local")).toBe("ok");
  });

  it("warns for anything else", () => {
    expect(envTone("staging")).toBe("warn");
  });
});

describe("prettyJson / looksLikeJson", () => {
  it("pretty-prints parseable JSON", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("passes unparseable text through untouched", () => {
    expect(prettyJson("not json")).toBe("not json");
  });

  it("labels an empty body", () => {
    expect(prettyJson("")).toBe("(empty body)");
    expect(prettyJson(null)).toBe("(empty body)");
    expect(prettyJson(undefined)).toBe("(empty body)");
  });

  it("detects JSON object and array literals, ignoring whitespace", () => {
    expect(looksLikeJson(' { "a": 1 } ')).toBe(true);
    expect(looksLikeJson("[1,2]")).toBe(true);
    expect(looksLikeJson("plain")).toBe(false);
    expect(looksLikeJson("")).toBe(false);
    expect(looksLikeJson(null)).toBe(false);
  });
});

describe("headerValue", () => {
  const headers = { "Content-Type": "application/json", "X-Trace": "abc" };

  it("looks a header up case-insensitively", () => {
    expect(headerValue(headers, "content-type")).toBe("application/json");
    expect(headerValue(headers, "x-trace")).toBe("abc");
  });

  it("returns null for a missing header or record", () => {
    expect(headerValue(headers, "authorization")).toBeNull();
    expect(headerValue(null, "content-type")).toBeNull();
    expect(headerValue(undefined, "content-type")).toBeNull();
  });
});
