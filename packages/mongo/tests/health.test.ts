import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  closeService,
  type EnterpriseServiceContext,
  makeEnterpriseService,
  maybeDescribe,
  probe,
} from "./helpers.ts";

const available = await probe();
const maybe = maybeDescribe(available);

maybe("service health (real MongoDB)", () => {
  let ctx!: EnterpriseServiceContext;
  beforeAll(async () => {
    ctx = await makeEnterpriseService("ninox_health_test");
  });
  afterAll(() => closeService(ctx));

  test("health reports ok for a connected database", async () => {
    const report = await ctx.service.health();
    expect(report.ok).toBe(true);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.dbs.length).toBe(1);
    expect(report.dbs[0]?.name).toBe("primary");
    expect(report.dbs[0]?.ok).toBe(true);
    expect(report.dbs[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("health stays ok across multiple calls", async () => {
    const a = await ctx.service.health();
    const b = await ctx.service.health();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});
