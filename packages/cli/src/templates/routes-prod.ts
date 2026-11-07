/**
 * @fileoverview Production-hardening route templates — routes every deployed
 * app should have, emitted by `ignex create` as baseline and installable on
 * existing apps via `ignex add ready`. Split from `./routes.ts` (which is at
 * its size-gate ceiling) so the production set can grow independently.
 */

/**
 * `src/routes/ready.get.ts` — readiness probe for load balancers and
 * orchestrators: 200 while every check passes, 503 otherwise, so a broken
 * replica stops receiving traffic instead of serving errors.
 */
export function readyRouteTemplate(): string {
  return `import type { ReadinessCheck } from "@ignex/core";
import { runReadinessChecks } from "@ignex/core";
import { get } from "@ignex/core/http";

/**
 * GET /ready — readiness probe for load balancers / orchestrators.
 *
 * /health says the process is up (liveness); /ready says this replica should
 * RECEIVE traffic. It returns 503 while any check fails. Add one entry per
 * real dependency (a DB ping, a cache round-trip); each check is capped at
 * 2s by runReadinessChecks. With no checks it answers 200 once booted.
 */
const checks: readonly ReadinessCheck[] = [
  // { name: "mongo", run: async () => (await service.health()).ok },
];

export default get(async (ctx) => {
  const report = await runReadinessChecks(checks);
  if (!report.ok) return ctx.json(report, { status: 503 });
  return report;
});
`;
}
