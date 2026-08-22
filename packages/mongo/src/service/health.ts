/**
 * Health check: pings every connected manager's raw `Db` handle in parallel
 * (with a 2s timeout per ping) and reports per-DB latency + overall status.
 * Types and implementation live together here so `service/index.ts` stays a
 * thin composition root.
 */
import type { Db } from "mongodb";
import { withTimeout } from "../utils/timeout.ts";

export interface DbHealthResult {
  /** Logical db client key (e.g. `primary`). */
  name: string;
  ok: boolean;
  /** Ping round-trip time in ms (present when `ok`). */
  latencyMs?: number;
}

export interface HealthReport {
  ok: boolean;
  /** Total elapsed time across all pings in ms. */
  latencyMs: number;
  dbs: DbHealthResult[];
}

/** Build a `health()` implementation over the service's manager record. */
export const createHealth = (db: Record<string, unknown>) => async (): Promise<HealthReport> => {
  const started = performance.now();
  const dbs = await Promise.all(
    Object.entries(db).map(async ([key, manager]) => {
      const name = key.replace(/Client$/, "");
      const handle = (manager as { client?: Db } | undefined)?.client;
      if (!handle) return { name, ok: false };
      try {
        const t0 = performance.now();
        await withTimeout(handle.admin().command({ ping: 1 }), 2_000, `health:${name}`);
        return { name, ok: true, latencyMs: performance.now() - t0 };
      } catch {
        return { name, ok: false };
      }
    }),
  );
  return { ok: dbs.every((r) => r.ok), latencyMs: performance.now() - started, dbs };
};
