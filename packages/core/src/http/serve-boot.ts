/**
 * @fileoverview Boot-time serve info broadcast.
 *
 * Plugins boot (`init`) BEFORE the listener is bound — the AOT bootstrap and
 * `createApp().serve()` both run plugin init first — so they cannot observe the
 * resolved serve origin themselves. This module is the narrow channel the
 * server framework uses to publish the effective protocol/port/hostname once
 * TLS has been resolved, before plugin `init` hooks run.
 *
 * Plugins that log their own endpoints at boot (debugbar, openapi) read it
 * through {@link bootOrigin} so a plain-HTTP (`server.https: false`) server
 * logs `http://…` URLs — never a guessed `https`.
 *
 * The value is process-wide ambient boot state, set once per server start and
 * never mutated afterwards (a later `.serve()` call overwrites it).
 */

/** Effective server values published before plugin boot. */
export interface ServeBootInfo {
  /** Resolved scheme ("http" when TLS is off or unavailable). */
  readonly protocol: "http" | "https";
  /** Listen port (as configured; `PORT` env wins at boot). */
  readonly port: number | string;
  /** Bind hostname, when the server config set one. */
  readonly hostname?: string;
}

let boot: ServeBootInfo | null = null;

/**
 * Publish the resolved serve values for plugin boot logs. Called by the server
 * framework (AOT bootstrap / `createApp().serve()`) once TLS is resolved and
 * before any plugin `init` hook runs.
 */
export const setServeBootInfo = (info: ServeBootInfo): void => {
  boot = info;
};

/** The last published serve values, or `null` before/without a server. */
export const getServeBootInfo = (): ServeBootInfo | null => boot;

/**
 * The user-facing origin (`scheme://host:port`) for boot URL logs.
 *
 * Falls back to the pre-boot heuristics when no server has published boot
 * info yet (plugin `init` invoked outside a server — e.g. unit tests): the
 * `PORT` env default 3000 and "http" in production / "https" in development
 * (the historical default, which a real boot always overrides). A bind
 * hostname of `0.0.0.0` / `::` is displayed as `localhost`.
 */
export const bootOrigin = (): string => {
  const scheme = boot?.protocol ?? (process.env.NODE_ENV === "production" ? "http" : "https");
  const port = boot?.port ?? process.env.PORT ?? "3000";
  let host = boot?.hostname;
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") host = "localhost";
  return `${scheme}://${host}:${port}`;
};
