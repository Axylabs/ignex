/**
 * Debug-usage detection tests — `ctx.debug` must force the full-context path.
 *
 * The debugbar tracing API (`ctx.debug`) is a full-context member (the plugin
 * injects it per request), so a route that touches it must never be compiled
 * to a usage-specialized context — the AOT `ContextUsage.debug` flag exists
 * exactly for this.
 */

import { EMPTY_USAGE, FULL_USAGE } from "@ignex/shared";
import { describe, expect, it } from "vitest";
import { parseModule } from "../src/utils/ast";

describe("ctx.debug usage detection", () => {
  it("flags direct ctx.debug.span calls", () => {
    const src = `
      import { get } from "@ignex/core/http";
      export default get(async (ctx) => {
        await ctx.debug.span("load", "db", () => Promise.resolve(1));
        return ctx.json({ ok: true });
      });
    `;
    const parsed = parseModule(src);
    expect(parsed.handler?.usage.debug).toBe(true);
  });

  it("flags destructured debug usage", () => {
    const src = `
      import { get } from "@ignex/core/http";
      export default get(async ({ debug, json }) => {
        await debug.query("SELECT 1", [], () => Promise.resolve(1));
        return json({ ok: true });
      });
    `;
    const parsed = parseModule(src);
    expect(parsed.handler?.usage.debug).toBe(true);
    expect(parsed.handler?.usage.json).toBe(true);
  });

  it("flags aliased debug (const d = ctx.debug)", () => {
    const src = `
      import { get } from "@ignex/core/http";
      export default get(async (ctx) => {
        const d = ctx.debug;
        d.event("boot");
        return ctx.json({ ok: true });
      });
    `;
    const parsed = parseModule(src);
    expect(parsed.handler?.usage.debug).toBe(true);
  });

  it("does not flag unrelated members", () => {
    const src = `
      import { get } from "@ignex/core/http";
      export default get((ctx) => ctx.json({ ok: true }));
    `;
    const parsed = parseModule(src);
    expect(parsed.handler?.usage.debug).toBe(false);
    expect(parsed.handler?.usage.json).toBe(true);
  });

  it("EMPTY_USAGE / FULL_USAGE include the debug flag", () => {
    expect(EMPTY_USAGE.debug).toBe(false);
    expect(FULL_USAGE.debug).toBe(true);
  });
});
