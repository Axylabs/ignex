/**
 * @fileoverview Multi-core server helper.
 *
 * Bun is single-threaded per JS context, but Bun.serve can use reusePort
 * to run multiple accept loops across CPU cores.
 */

export type ServeOptions = Parameters<typeof Bun.serve>[0];

export interface ClusterServeOptions extends ServeOptions {
  /**
   * Number of server instances.
   * Use "auto" to match CPU count.
   */
  workers?: number | "auto";
}

export function serveCluster(options: ClusterServeOptions) {
  const requested = options.workers ?? 1;

  const count =
    requested === "auto"
      ? Math.max(1, navigator.hardwareConcurrency || 1)
      : Math.max(1, Number(requested));

  const serveOptions: ServeOptions = { ...options };
  delete (serveOptions as any).workers;

  const servers = Array.from({ length: count }, () =>
    Bun.serve({
      ...serveOptions,
      reusePort: count > 1 ? true : serveOptions.reusePort,
    })
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