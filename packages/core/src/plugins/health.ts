/**
 * @fileoverview Health + readiness probe plugin.
 *
 * `/health` (liveness) says the process is up — it must NEVER touch external
 * dependencies, or a dead database turns into a restart loop. `/ready`
 * (readiness) runs registered dependency checks (DB ping, store health, …)
 * and reports 503 when any fail, so load balancers stop routing to a replica
 * that cannot serve traffic — previously every instance reported healthy
 * regardless of dependency state.
 *
 * Interpreted apps: `plugins: [healthProbe({ readiness: [...] })]` registers
 * both endpoints on the router. AOT/compiled apps: use `runReadinessChecks()`
 * inside a `src/routes/ready.get.ts` route file (the compiler discovers file
 * routes; plugin-registered routes are an interpreted-only feature).
 */
import type { IgnexRouter } from "../http/router";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** One named dependency check. Return `true` when the dependency can serve. */
export interface ReadinessCheck {
  /** Stable check name reported in the JSON body (`"mongo"`, `"redis"`, …). */
  readonly name: string;
  /** Run the check. Throw or return `false` to mark NOT ready. */
  readonly run: () => boolean | Promise<boolean>;
}

/** Options for {@link healthProbe}. */
export interface HealthProbeOptions {
  /** Liveness path (default `/health`). */
  livenessPath?: string;
  /** Readiness path (default `/ready`). */
  readinessPath?: string;
  /**
   * Dependency checks for the readiness endpoint. An empty list means ready
   * immediately after boot.
   */
  readiness?: readonly ReadinessCheck[];
  /**
   * Per-check timeout in ms (default 2000). A hung check counts as failed —
   * a stuck DB driver must not hang the probe request forever.
   */
  timeoutMs?: number;
  /**
   * Cache successful results for this many ms (default 0 = always fresh).
   * Caching bounds probe cost when the LB hammers /ready every second and a
   * check does real I/O.
   */
  cacheMs?: number;
}

/** The aggregate readiness result (also used by `runReadinessChecks`). */
export interface ReadinessReport {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<{ name: string; ok: boolean; error?: string }>;
}

const withTimeout = async (
  check: ReadinessCheck,
  timeoutMs: number,
): Promise<{ name: string; ok: boolean; error?: string }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(check.run)
        .then((ok) => ({ ok: ok === true })),
      new Promise<{ ok: false; error: string }>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: `timeout after ${timeoutMs}ms` }),
          timeoutMs,
        );
      }),
    ]);
    return { name: check.name, ...raced };
  } catch (err) {
    return {
      name: check.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Run every readiness check (bounded by `timeoutMs`) and aggregate into a
 * {@link ReadinessReport}. Exported so AOT apps can drive `/ready` from a
 * plain file route with identical semantics.
 */
export const runReadinessChecks = (
  checks: readonly ReadinessCheck[],
  timeoutMs = 2_000,
): Promise<ReadinessReport> =>
  Promise.all(checks.map((check) => withTimeout(check, timeoutMs))).then((checks) => ({
    ok: checks.every((c) => c.ok),
    checks,
  }));

/**
 * Create the health + readiness plugin (interpreted apps).
 *
 * @example
 * ```ts
 * import { healthProbe } from "@ignex/core";
 *
 * export const plugins = [
 *   healthProbe({
 *     readiness: [
 *       { name: "mongo", run: () => db.command({ ping: 1 }).then(() => true) },
 *     ],
 *   }),
 * ];
 * ```
 */
export const healthProbe = (options: HealthProbeOptions = {}): IgnexPlugin => {
  const livenessPath = options.livenessPath ?? "/health";
  const readinessPath = options.readinessPath ?? "/ready";
  const checks = options.readiness ?? [];
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheMs = options.cacheMs ?? 0;

  let cachedAt = 0;
  let cachedReport: ReadinessReport | null = null;

  return {
    name: "healthProbe",
    version: "0.1.0",

    routes(router: IgnexRouter) {
      // Liveness: process-local, dependency-free, always cheap.
      router.get(livenessPath, () => Response.json({ status: "ok", time: Date.now() }));

      router.get(readinessPath, async () => {
        if (cachedReport && cacheMs > 0 && cachedReport.ok && Date.now() - cachedAt < cacheMs) {
          return Response.json(cachedReport);
        }
        const report = await runReadinessChecks(checks, timeoutMs);
        if (report.ok && cacheMs > 0) {
          cachedReport = report;
          cachedAt = Date.now();
        }
        return Response.json(report, { status: report.ok ? 200 : 503 });
      });
    },
  };
};
