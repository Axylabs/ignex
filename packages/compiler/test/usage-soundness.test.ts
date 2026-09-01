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
