/**
 * Multi-core server helper.
 *
 * Fixed:
 * - uses node:os availableParallelism()
 * - avoids extending a union type
 * - satisfies exactOptionalPropertyTypes
 */

import { availableParallelism } from "node:os";

export type ServeOptions = Parameters<typeof Bun.serve>[0];

export type ClusterServeOptions = ServeOptions & {
  workers?: number | "auto";
};

export function serveCluster(options: ClusterServeOptions) {
  const requested = options.workers ?? 1;

  const count =
    requested === "auto"
      ? Math.max(1, availableParallelism())
      : Math.max(1, Number(requested));

  const serveOptions: Record<string, unknown> = { ...options };

  delete serveOptions.workers;

  if (count > 1) {
    serveOptions.reusePort = true;
  }

  const servers = Array.from({ length: count }, () =>
    Bun.serve(serveOptions as unknown as ServeOptions),
  );

  return {
    servers,
    port: servers[0]?.port,
    stop() {
      for (const server of servers) {
        server.stop();
      }
    },
  };
}