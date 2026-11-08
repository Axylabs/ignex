/**
 * @fileoverview Feature-bundle library templates — the module-scope singletons
 * `ignex add`/`ignex create --features` emit for the production modules that
 * need a shared instance: metrics registry, durable job queue, realtime hub,
 * mailer, and the typed RPC kit. Split from `./routes.ts` (size gate) — these
 * are `src/lib/*`/`src/rpc/*` modules, not route files.
 *
 * Every template imports its validated env through `../config/env.js` (the
 * scaffold's `defineEnv` contract) so the generated code has no raw
 * `process.env` reads.
 */

/** `src/lib/metrics.ts` — shared registry scraped at /metrics + optional OTLP push. */
export function metricsLibTemplate(): string {
  return `import { createMetrics, createOtlpExporter } from "@ignex/core";
import { env } from "../config/env.js";

/**
 * Shared metrics registry — the metricsPlugin serves it at /metrics in
 * Prometheus text format (protect it with METRICS_TOKEN / proxy rules).
 */
export const metrics = createMetrics();

// Optional OTLP metrics push. Stop the exporter during application shutdown.
export const otlp = env.OTLP_ENDPOINT
  ? createOtlpExporter(metrics, { endpoint: env.OTLP_ENDPOINT })
  : null;
otlp?.start();

export const metricsLifecycle = {
  name: "metrics-lifecycle",
  async close(): Promise<void> {
    await otlp?.stop();
  }
};
`;
}

/** `src/lib/jobs.ts` — durable (SQLite) job queue + handler registry. */
export function durableJobsLibTemplate(): string {
  return `import { mkdirSync } from "node:fs";
import { type JobHandler, type JobStore, createDurableJobQueue, createSqliteJobStore } from "@ignex/core";

/**
 * Handler registry — one entry per background job name. Enqueue from any
 * route or hook:  await jobs.enqueue({ name: "send-welcome", payload });
 */
const handlers: Record<string, JobHandler> = {
  // "send-welcome": async (payload) => { /* ... */ },
};

/**
 * Durable queue — SQLite-backed (WAL), lease-claimed, multi-process safe.
 * Process it with \`ignex queue:work\` (run 2+ workers for redundancy);
 * \`ignex schedule:run\` fires recurring entries from src/schedule.ts.
 */
mkdirSync("./data", { recursive: true });
const store = await createSqliteJobStore("./data/jobs.db");
if (!store) throw new Error("Durable jobs require bun:sqlite");
const jobStore: JobStore = store;
export const jobs = createDurableJobQueue({ store: jobStore, handlers, concurrency: 2 });
export function start(): void {
  jobs.start();
}
export async function stop(): Promise<void> {
  await jobs.stop();
  await jobStore.close?.();
}
`;
}

/** `src/lib/realtime.ts` — typed WS pub/sub hub via the optional nova peer. */
export function realtimeLibTemplate(): string {
  return `import { novaPlugin } from "@ignex/core";
import { env } from "../config/env.js";

/**
 * Realtime hub (typed WS pub/sub through the optional peer @ignex/nova).
 *
 *   bun add @ignex/nova
 *
 * The hub listens on its own port (NOVA_PORT, default 3001) — expose it
 * through your proxy and keep sticky sessions when scaling horizontally.
 * Bridge auth by passing \`authenticate\` (see the novaPlugin docs).
 */
export const realtime = novaPlugin({
  port: env.NOVA_PORT,
  path: "/ws",
});
`;
}

/** `src/lib/mailer.ts` — transactional email (log driver until SMTP is set). */
export function mailerLibTemplate(): string {
  return `import { createMailer } from "@ignex/core";
import { env } from "../config/env.js";

/**
 * Transactional email. Uses the built-in \`log\` driver until SMTP_HOST is
 * set (then real SMTP via pooled nodemailer). Delivery failures reject;
 * queue important messages and close the mailer during application shutdown.
 */
export const mailer = createMailer(
  env.SMTP_HOST
    ? {
        driver: "smtp",
        from: env.SMTP_FROM,
        smtp: {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          auth: env.SMTP_USER
            ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" }
            : undefined,
        },
      }
    : { driver: "log", from: env.SMTP_FROM },
);

export const mailerLifecycle = {
  name: "mailer-lifecycle",
  close: () => mailer.close()
};
`;
}

/** `src/rpc/kit.ts` — typed, schema-validated RPC methods over the realtime hub. */
export function rpcKitTemplate(): string {
  return `import { Type } from "typebox";
import { Check } from "typebox/value";
import { createRpcKit } from "@ignex/core";

/**
 * Typed RPC kit — schema-validated methods served over the realtime hub
 * (novaPlugin). Define one entry per method; the SDK-facing manifest lands
 * in .ignex/rpc-manifest.json. Call \`await rpc.registerDispatcher()\`
 * after the hub boots (see the realtime kit docs for the full wiring).
 */
export const rpc = createRpcKit({
  manifestPath: ".ignex/rpc-manifest.json",
  fallbackCheck: (schema, value) => Check(schema, value)
});

rpc.define("ping", {
  schema: Type.Object({ echo: Type.Optional(Type.String()) }),
  handler: async (payload) => ({ pong: payload, at: Date.now() }),
});

export const rpcLifecycle = {
  name: "rpc-lifecycle",
  init: () => rpc.registerDispatcher()
};
`;
}

/** `src/realtime.ts` — realtime control-channel declarations for the RPC bundle. */
export function rpcRealtimeTemplate(): string {
  return `import { Type } from "typebox";

export const realtime = {
  events: {},
  controlEvents: {
    "rpc.request": Type.Object({
      id: Type.String(),
      method: Type.String(),
      payload: Type.String()
    }),
    "rpc.response": Type.Object({
      id: Type.String(),
      ok: Type.Boolean(),
      data: Type.String(),
      error: Type.String()
    })
  }
};
`;
}
