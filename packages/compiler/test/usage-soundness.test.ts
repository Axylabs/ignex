/**
 * Context-usage analysis soundness tests.
 *
 * The usage bitmap directly gates codegen's specialized-context emission:
 * a FALSE NEGATIVE (flag unset though the handler reads the member) compiles
 * to a context missing that member — the handler silently reads `undefined`
 * at runtime. These tests pin the conservative behavior: any pattern the
 * analyzer cannot enumerate must degrade UP to full usage, never down.
 */

import { FULL_USAGE } from "@ignex/shared";
import { describe, expect, it } from "vitest";
import { extractHandlerNodeAST } from "../src/utils/ast/handler";
import { parseModule } from "../src/utils/ast/parse";
import { buildContextMapping, detectUsage } from "../src/utils/ast/usage";

/** Mirror `buildExtractedHandler`: mapping from fn params + walk of the body. */
const analyze = (source: string) => {
  const mod = parseModule(source);
  const fn = extractHandlerNodeAST(mod.ast);
  if (!fn) throw new Error("no handler function extracted");
  return detectUsage(fn.body ?? fn, buildContextMapping(fn.params));
};

describe("context usage soundness", () => {
  it("tracks plain destructured params (baseline specialization still works)", () => {
    const usage = analyze(`export default ({ query }) => json(query);`);
    expect(usage.query).toBe(true);
    expect(usage.body).toBe(false);
  });

  it("tracks destructured params WITH defaults (`({ query = {} }) => …`)", () => {
    // Regression: AssignmentExpression initializers used to drop the alias,
    // leaving query unflagged → generated context had no `query` member.
    const usage = analyze(`export default ({ query = {} }) => json(query.foo);`);
    expect(usage.query).toBe(true);
  });

  it("rest-element params force FULL usage", () => {
    // `({ ...rest })` can carry any members — only sound outcome is all flags.
    const usage = analyze(`export default ({ ...rest }) => json(rest.body);`);
    expect(usage).toEqual(FULL_USAGE);
  });

  it("body-level destructuring off ctx is tracked (`const { body } = ctx`)", () => {
    // Regression: ObjectPattern declarator ids were silently skipped.
    const usage = analyze(`
      export default (ctx) => {
        const { body } = ctx;
        return json(body);
      };
    `);
    expect(usage.body).toBe(true);
  });

  it("ctx.method gets its OWN flag, not `url`", () => {
    // Regression: `method` used to collapse onto the `url` flag. Codegen emits
    // the flagged member and nothing else, so a specialized route that read
    // `ctx.method` got `url` emitted and `method` missing — the handler read
    // `undefined` at runtime, silently. The two must be distinct flags.
    const usage = analyze(`export default (ctx) => ctx.json({ m: ctx.method });`);
    expect(usage.method).toBe(true);
    // Reading the method does NOT need a URL object to be built.
    expect(usage.url).toBe(false);
  });

  it("ctx.path gets its OWN flag, not `url`", () => {
    // Same regression class as `method`: `path` shared the `url` flag while no
    // `path` member was ever emitted, so `ctx.path` was `undefined` on a
    // specialized route.
    const usage = analyze(`export default (ctx) => ctx.json({ p: ctx.path });`);
    expect(usage.path).toBe(true);
    expect(usage.url).toBe(false);
    expect(usage.method).toBe(false);
  });

  it("reading the request's identity sets a flag, so it can force the full context", () => {
    // These four had NO `USAGE_FLAGS` entry, so a handler reading one set no
    // flag, stayed on the specialized tier, and read `undefined` where the
    // interpreted path returned a real value (§30).
    const usage = analyze(`
      export default (ctx) =>
        ctx.json({ ip: ctx.ip, route: ctx.route, requestId: ctx.requestId, startTime: ctx.startTime });
    `);
    expect(usage).toMatchObject({ ip: true, route: true, requestId: true, startTime: true });
  });

  it("passing the context root to a callee forces FULL usage", () => {
    // THE bug this rule exists for: `queryRecord(ctx)` where queryRecord lives
    // in ANOTHER module. The walker cannot see that it reads `ctx.url`, so the
    // specialized context omitted `url` and the helper read `undefined` — a 500
    // on the compiled path where the interpreted path returned 200.
    const usage = analyze(`
      import { queryRecord } from "./bench";
      export default (ctx) => ctx.json(queryRecord(ctx));
    `);
    expect(usage).toEqual(FULL_USAGE);
  });

  it("a spread of the root escapes (`attach({ ...ctx })`)", () => {
    const usage = analyze(`export default (ctx) => send({ ...ctx });`);
    expect(usage).toEqual(FULL_USAGE);
  });

  it("an ALIAS of the root escapes (`const c = ctx; helper(c)`)", () => {
    const usage = analyze(`
      export default (ctx) => {
        const c = ctx;
        return helper(c);
      };
    `);
    expect(usage).toEqual(FULL_USAGE);
  });

  it("storing the root on an object escapes (`box.ctx = ctx`)", () => {
    const usage = analyze(`
      export default (ctx) => {
        box.ctx = ctx;
        return json({});
      };
    `);
    expect(usage).toEqual(FULL_USAGE);
  });

  it("does NOT over-degrade: the root as a CALLEE is not an escape", () => {
    // `ctx.json(...)` uses the root as the receiver, not as an argument. If the
    // escape rule fired here, every route would lose specialization entirely.
    const usage = analyze(`export default (ctx) => ctx.json({ ok: true });`);
    expect(usage.json).toBe(true);
    expect(usage).not.toEqual(FULL_USAGE);
  });

  it("does NOT over-degrade: passing a MEMBER is not an escape", () => {
    // `rateLimitCheck(ctx.ip, now)` flags only `ip`; the rest stays specialized.
    const usage = analyze(`export default (ctx) => ctx.json(rateLimitCheck(ctx.ip, 1));`);
    expect(usage.ip).toBe(true);
    expect(usage.body).toBe(false);
    expect(usage.url).toBe(false);
  });

  it("body-level destructuring with defaults is tracked", () => {
    const usage = analyze(
      `
      export default (ctx) => {
        const { query = {} } = ctx;
        return json(q ?? null), undefined;
      };
    `.replace("q ?? null", "query ?? null"),
    );
    expect(usage.query).toBe(true);
  });

  it("root re-aliasing in the body is tracked (`const b = ctx; b.body`)", () => {
    const usage = analyze(`
      export default (ctx) => {
        const b = ctx;
        return json(b.body);
      };
    `);
    expect(usage.body).toBe(true);
  });

  it("nested destructuring degrades UP to full usage instead of dropping", () => {
    const usage = analyze(`
      export default ({ user: { name } }) => json(name);
    `);
    expect(usage).toEqual(FULL_USAGE);
  });
});
