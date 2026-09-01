import type { ReadinessCheck } from "@ignex/core";
import { runReadinessChecks } from "@ignex/core";
import { get } from "@ignex/core/http";
import { service } from "../db.js";

/**
 * GET /ready — readiness probe for load balancers / orchestrators.
 *
 * Unlike /health (liveness: process is up), this runs a REAL dependency check
 * (Mongo ping via ninox's `service.health()`) and returns 503 when it fails —
 * so a replica with a dead MongoDB stops receiving traffic instead of serving
 * errors. AOT note: plugin-registered routes don't exist in compiled apps, so
 * the probe lives here as a file route using `runReadinessChecks` (the same
 * semantics as the interpreted-only `healthProbe()` plugin).
 */
const checks: readonly ReadinessCheck[] = [
  {
    name: "mongo",
    // `service.health()` pings every connected DB; treat any unhealthy DB as
    // not-ready. The 2s per-check cap in runReadinessChecks bounds a hung
    // driver.
    run: async () => {
      const report = await service.health();
      return report.ok;
    },
  },
];

export default get(async (ctx) => {
  const report = await runReadinessChecks(checks);
  if (!report.ok) return ctx.json(report, { status: 503 });
  return report;
});
