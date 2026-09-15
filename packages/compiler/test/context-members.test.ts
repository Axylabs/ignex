/**
 * Structural tests for the usage-specialized context object literal.
 *
 * The analyzer and codegen share one vocabulary of `ContextUsage` flags, and the
 * contract between them is implicit: if the analyzer sets `ctx.FOO`'s flag, then
 * codegen MUST emit a `FOO` member. Nothing type-checks that — the emitted object
 * literal is a string — so a collapsed flag compiles cleanly and the handler
 * silently reads `undefined` at runtime on the fast path, where the full context
 * would have given a real value.
 *
 * That is exactly what happened twice: `ctx.method` and `ctx.path` shared the
 * `url` flag, so codegen emitted `url` and never `method`/`path`. Both were
 * divergent between compiled and interpreted builds, and neither the type checker
 * nor the analyzer suite could see it. These tests make the contract explicit.
 */

import { type ContextUsage, EMPTY_USAGE } from "@ignex/shared";
import { describe, expect, it } from "vitest";
import { buildContextProps } from "../src/phases/codegen/routes/context";
import type { RouteIR } from "../src/types";

/**
 * Route IR carrying exactly one usage flag.
 *
 * `buildContextProps` reads nothing else off the IR except the validators, which
 * are absent here, so the rest of the shape is not exercised.
 */
const routeWith = (flag: keyof ContextUsage): RouteIR =>
  ({
    analysis: { usage: { ...EMPTY_USAGE, [flag]: true } },
    decisions: {},
  }) as unknown as RouteIR;

/** Flags whose member must appear on the specialized context. */
const EMITTED: readonly string[] = [
  "body",
  "params",
  "query",
  "headers",
  "state",
  "req",
  "url",
  "method",
  "path",
  "cookie",
  "server",
  "set",
  "json",
  "text",
  "html",
  "redirect",
  "stream",
  "empty",
  "status",
  "sendFile",
  "proxy",
  "forward",
];

/**
 * Flags that force `needsFull` instead, so routes using them never reach the
 * specialized tier and codegen has nothing to emit for them. `file`, `cache`,
 * `loader` and `debug` double as tripwires for "the analyzer gave up"
 * (`FULL_USAGE` sets all four), which is what keeps unresolvable handlers on the
 * full context. `ip`, `route`, `requestId` and `startTime` are the request's
 * identity: they had no flag at all until §30, so a compact route reading one
 * read `undefined` on the fast path while the full context returned a value.
 */
const SENTINEL: readonly string[] = [
  "file",
  "cache",
  "loader",
  "debug",
  "ip",
  "route",
  "requestId",
  "startTime",
];

const CLASSIFIED = new Set([...EMITTED, ...SENTINEL]);
const KNOWN = new Set(Object.keys(EMPTY_USAGE));

/** True when `props` declares a member named `flag` (`foo` or `foo: ...`). */
const emitsMember = (props: readonly string[], flag: string): boolean =>
  props.some((prop) => prop === flag || prop.startsWith(`${flag}:`) || prop.startsWith(`${flag} `));

describe("usage-specialized context members", () => {
  it.each(EMITTED)("emits a `%s` member for its own flag", (flag) => {
    const props = buildContextProps(routeWith(flag as keyof ContextUsage), new Set<string>());

    expect(
      emitsMember(props, flag),
      `usage.${flag} was set but codegen emitted no \`${flag}\` member ` +
        `(got: ${props.join(", ")}) — the handler would read undefined on the ` +
        "specialized tier. Give it its own flag and emit the member.",
    ).toBe(true);
  });

  it("classifies every ContextUsage flag as emitted or sentinel", () => {
    const unclassified = Object.keys(EMPTY_USAGE).filter((flag) => !CLASSIFIED.has(flag));

    expect(
      unclassified,
      "a new usage flag was added without deciding how codegen satisfies it — " +
        "add it to EMITTED (and emit the member) or to SENTINEL (and list it in " +
        "needsFull)",
    ).toEqual([]);
  });

  it("lists no flag that EMPTY_USAGE no longer declares", () => {
    const stale = [...CLASSIFIED].filter((flag) => !KNOWN.has(flag));

    expect(stale, "these entries are stale; the flag was removed or renamed").toEqual([]);
  });
});
